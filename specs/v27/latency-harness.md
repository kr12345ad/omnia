# M4.5 — Latency Harness Spec

Status: Draft for builder review (M4.5, 4–5 days, parallel to M4)

Purpose: produce the measured evidence behind the per-platform Screen Copilot go/no-go. Default-deny: a platform with no measurement is **red** and Copilot stays disabled there. Linux is measured first; every other OS is enabled only from its own green record.

## 1. Decision this feeds

Per-platform capability tiers for Screen Copilot (M5), decided from p95 numbers in a signed decision record (§7):

1. **Halo tier** — hotkey to halo first frame (overlay only, no model).
2. **Ask tier** — question about the screen (Moondream, full response).
3. **Point tier** — grounding (UI-TARS), required to spotlight/point.

Agreed thresholds (manager, R2): halo green <150 ms p95; amber 150–400 ms (off by default, explicit opt-in); red >400 ms or no data (disabled on that platform). Ask/point thresholds are **proposed here** and need sign-off in the M4.5 review: point green ≤2 s p95, amber 2–4 s (off by default, "assistive, may be wrong"), red >4 s or no data; ask green ≤2.5 s, amber 2.5–6 s, red >6 s or no data. A red point tier with green/amber ask tier yields an answer-only Copilot that never points.

## 2. Scope and non-goals

In scope: local, opt-in instrumentation of three existing latency segments; JSONL sample records; p50/p95 report generator; per-platform hardware matrix; decision record template.

Out of scope: new SSE event types (baseline reuses existing events plus in-process timers); token streaming (llama.cpp call is non-streaming today — see §4.3); any telemetry, upload, or cloud dependency; UI for the report itself.

Invariants:
- Harness off (default) performs zero writes and adds no measurable work to the action path.
- Samples never contain screenshots, window titles, file paths, secret values, or model prompts — durations, counts, identifiers, and hardware facts only.
- Enabling the harness never changes permission behavior; fixtures run under an explicit test profile.

## 3. Data flow

```
runner script ──writes──> ~/.omnia/latency/run.json  (runId, scenario set, n)
      │
      ├── drives /v1/computer-use/analyze|perform (sandbox profile)
      │        └── omnia server: capture + provider timers ──append──> latency-*.jsonl
      └── triggers halo (UI-mode) or via performed action (API-mode)
               └── desktop main: t0 → overlay show → paint ack ──append──> latency-*.jsonl
report script ──reads jsonl + run.json──> latency-report-*.md / .csv
```

Writers: server module `packages/omnia/src/latency/writer.ts` and desktop helper `packages/desktop/src/main/omnia/latency.ts`, both appending JSONL with the `appendFileSync` pattern from `packages/opencode/src/cli/cmd/run/trace.ts:24-37`. Both resolve the output dir `~/.omnia/latency` (same convention as models/runtimes, `packages/omnia/src/computer-use/local.ts:96-98`) and read `run.json` for the active `runId` (cached ≤5 s). No `OMNIA_HOME` helper exists; keep the path inline like existing call sites.

## 4. Instrumentation

### 4.0 Mode gating

- Server setting `computerUse.latencyHarness` (boolean, default false) persisted with the other computer-use settings (`packages/omnia/src/computer-use/service.ts:760`), plus env override `OMNIA_LATENCY_HARNESS=1` for scripted runs.
- Settings > Computer use row "Performance diagnostics (local)" following `settings-computer-use.tsx` conventions (`Switch` from `@opencode-ai/ui/switch`), i18n keys `settings.computerUse.latencyHarness` + `.description` added to `packages/app/src/i18n/en.ts` and every locale per the parity test.
- When off, the timer wrappers are a single boolean check; add a unit test asserting no file/dir is created.

### 4.1 Halo summon → paint (desktop, `halo.paint`)

Existing path (verified by recon): desktop main subscribes to the server EventBus (`packages/desktop/src/main/index.ts:370`), `agent-state.ts:51-58` marks native activity, `agent-working.ts:50-54` calls `overlay.showWorking()`, `overlay.ts:122-128` creates/presents, `present()` calls `win.showInactive()` at `overlay.ts:48`. `hideWorking()` **destroys** the window (`overlay.ts:129-131`), so any re-show after idle is a cold create + `ready-to-show` + load; warm only when summoned while already visible. Cold/warm must be tagged separately; expect cold to dominate.

Gaps: no timestamp anywhere on this path; the overlay window has **no preload** (`overlay.ts:88-93`) and its renderer only toggles a CSS class (`packages/desktop/src/renderer/overlay.ts:1-8`); no paint acknowledgment exists.

Minimal change:
1. `t0` = `performance.now()` at `showWorking()` entry; record `cold = !(win alive && ready)` and `createMs` when the `ready-to-show` handler (`overlay.ts:104-108`) fires.
2. Add a sandboxed preload to the overlay window exposing only `overlayApi.painted(nonce)`. Main arms each show with a fresh nonce (`webContents.send("overlay:armed", nonce)` in `present()`), the renderer answers on the first `requestAnimationFrame` after `document.visibilityState === "visible"`, and main stamps `t1 = performance.now()` on receipt (fire-and-forget; stale nonces ignored).
3. `totalMs = t1 − t0`; sub-metrics `createMs`, `showToPaintMs`. If no ack within 1000 ms, write the sample with `painted:false`, `totalMs` to `showInactive`, and `notes:"approximate"` — never block or delay the overlay path.
4. M5 hotkey (none exists today — no `globalShortcut` anywhere in the repo, recon verified): when added, also stamp the hotkey handler and emit both brackets. For M4.5 baseline, `showWorking()` entry is the trigger.

Clock note: measure the hop entirely in the main process (t0 and ack receipt); do not compare renderer and main clocks.

### 4.2 Grounding (server, `vision.capture` + `vision.ground`)

Existing path: `service.analyze()` (`packages/omnia/src/computer-use/service.ts:202-317`) → `buildContext()` (`:601-623`) → `capture()` (`:625-633`, `driver.execute({type:"screenshot"})`; per-OS capture is `linux.ts:1533-1588`, `darwin.ts:834-845`, `windows.ts:779-786`) → provider loop `:278-311` → UI-TARS `analyze()` (`providers.ts:447-547`, `started` at `:448`).

Gaps/caveats:
- No timestamp around capture; `buildContext` captures **before** routing, so request wall time = capture + route + provider.
- `ComputerUseResult.latencyMs` starts after capture but **includes** `ensureLoaded` cold load, ffmpeg compression, and HTTP inference — it is not "inference only". The only pure inference timer is `inferenceMs` in the crop path (`providers.ts:582,599`).
- `service.now` is injected but unused; providers use raw `Date.now()`.

Change: add monotonic `performance.now()` wrappers — `captureMs` inside `capture()`, `providerMs` from the provider attempt, and `totalMs` around `analyze()` via a single `withLatency("vision.ground", fn)` wrapper so every return path (`title_bar_ban`, `no_visual_provider`, success, failure) emits one sample. Sample fields: `captureMs`, `providerMs`, `inferenceMs` (crop path only, else null), `totalMs`, `fallbacks`, `errorCode`.

### 4.3 Question (server, `vision.question`)

Same wrapper around the Moondream path (`providers.ts:254-355`, `started` at `:255`, `maxTokens` 48/320 at `:291`). **Correction to R2:** `LocalModelManager.chat()` is non-streaming — `stream:false` and a single `await response.json()` (`packages/omnia/src/computer-use/local.ts:552-557`). Baseline measures full response time only; first-token latency is not available today. Optional stretch (not baseline): add `stream:true` passthrough in `local.chat` and record `ttftMs`; treat as a separate small change with its own test.

### 4.4 Other bracketing (SSE, no new event types)

Use existing events where they already bracket a segment: `action.requested|started|completed|verified` (`server/events.ts:17-21`; emitted with `event.at` only — no duration field), `computer_use.analyzed` (`service.ts:303-305,510-512`, carries provider `latencyMs`), `input.frozen|released` (`computers.ts:560,567,733,765`). The harness does not add event types; it adds in-process timers at the gaps above and writes file samples. Optional (only if the builder prefers): an appended `harness` sub-object on `computer_use.analyzed` data when enabled — strictly additive, off by default.

### 4.5 Sample record schema (one JSON object per line)

```json
{
  "schema": "omnia.latency.v1",
  "runId": "2026-09-27T10-00-linux-x64",
  "seq": 1,
  "ts": 1780000000000,
  "segment": "halo.paint | vision.capture | vision.ground | vision.question",
  "platform": { "os": "linux|darwin|win32", "release": "5.14.0", "arch": "x64|arm64", "packaged": true },
  "hardware": { "cpu": "AMD Ryzen ...", "cores": 8, "ramGB": 16, "gpu": "Radeon 780M", "backend": "vulkan|cpu|metal|cuda|rocm|null" },
  "app": { "desktopVersion": "26.9.0", "serverVersion": "0.1.0", "engineVersion": "1.18.32", "commit": null },
  "scenario": { "id": "ground.fixture-button@1080p", "model": "ui-tars-2b-q4_k_m", "screen": { "w": 1920, "h": 1080, "scale": 1 }, "cold": true, "maxTokens": 256 },
  "measures": { "totalMs": 0, "captureMs": null, "providerMs": null, "inferenceMs": null, "createMs": null, "showToPaintMs": null, "ttftMs": null },
  "outcome": { "success": true, "errorCode": null, "fallbacks": 0, "painted": true },
  "notes": null
}
```

Identity gaps (verified): `desktopVersion` via `app.getVersion()` (`packages/desktop/src/main/logging.ts:133-150` has a ready-made manifest template); `serverVersion` is `OMNIA_SERVER_VERSION` (`packages/omnia/src/server/server.ts:42`); engine version is build-time (`packages/opencode/script/build.ts:192-199`). **No runtime git commit constant exists** — either add a build define following the `OPENCODE_VERSION` pattern or leave `commit:null` and record the report date; do not shell out to git at runtime.

Redaction rules: no image data, no window titles, no target descriptions (M5 scenario ids are synthetic fixture names), no tokens, no paths. `scenario.id` values must be from a fixed allowlist defined in the runner.

## 5. p50/p95 method and report format

- Per scenario, per platform, per backend: 3 discarded warmups, then n=30 measured samples (minimum for a decision claim; report may print a red interim after 15 with `n<30` flag, but green/amber require n≥30). Cold and warm halo samples are separate scenarios.
- Percentile: nearest-rank. Sort ascending; `rank = ceil(p/100 × n)`; value is the `rank`-th element (1-based). p50 and p95 from the same function. Unit-test with known arrays, including n=30 and ties.
- Report generator `script/latency-report.ts` (new), reusing the warmup/median conventions of `packages/opencode/script/bench-test-suite.ts` (`BENCH_WARMUPS`/`BENCH_RUNS`, `perf/test-suite.md:36` METRIC lines). Outputs `latency-report-<os>-<arch>-<backend>-<stamp>.md` and `.csv` next to the raw JSONL; header block copied from the `manifest()` shape (`logging.ts:133-150`).
- Report body: one table per segment with `n, p50, p95, max, success rate, fallback rate, cold/warm`; then `METRIC halo_hop_p50_ms=…`, `METRIC halo_hop_p95_ms=…`, `METRIC vision_ground_p95_ms=…`, `METRIC vision_question_p95_ms=…`; then the verdict per tier and the decision record (§7).
- Commit and date in the header. Reports live outside the repo in `~/.omnia/latency`; if any report is committed, add a new `.gitignore` rule (only `logs/` is ignored today).

## 6. Per-platform hardware matrix

Every row is **red until measured** (default-deny). "Access" = hardware + packaged build obtained.

| # | OS / arch | Backends available | Access today | Required runs | Status |
|---|-----------|--------------------|--------------|---------------|--------|
| 1 | linux-x64 (current Rocky 9 host) | cpu, vulkan bundled; cuda/rocm downloadable | Yes | halo cold+warm, ground, question on **vulkan** and **cpu** | Ready to measure |
| 2 | linux-arm64 | cpu, vulkan catalog | No hardware | same as #1 | Red (missing) |
| 3 | darwin-arm64 (M-series, base 8 GB) | **metal only** (catalog has metal build, `runtimes.ts:125-137`) | No packaged build in checkout; CI publishes mac artifacts (`publish.yml` macos jobs) | halo, ground, question on metal | Red (missing) |
| 4 | darwin-x64 | metal only | No | same | Red (missing) |
| 5 | win-x64 iGPU/i5 class | cpu, vulkan bundled; cuda catalog | Unknown; Windows CI exists in test.yml/publish.yml | halo, ground, question on cpu and vulkan | Red (missing) |
| 6 | win-x64 with NVIDIA (optional, best case) | cuda | Unknown | ground/question on cuda | Red (missing) |

Run rules: 1080p fixture (1440p only if the same device provides it; do not mix resolutions in one report); warm model loaded (`ensureLoaded` complete) except a dedicated cold-start note; packaged builds only — dev-run numbers are tagged `packaged:false` and cannot satisfy a decision.

Known platform risk to verify during #5: `hardware.ts:76-77` reads `/sys/class/drm` for AMD without an OS guard (code-inspection inference, not reproduced); if it throws on Windows, the hardware block of the sample is degraded, not the run.

## 7. Green/amber/red decision record

Template, one per platform, stored beside the report and copied into the PR/issue that flips the flags:

```md
# Latency decision — <os>-<arch>-<backend>
Date: <date>   Build: v26.9.0+<commit or "commit n/a">   Packaged: yes
Evidence: <report file> sha256 <hash>; raw <file> sha256 <hash>
Samples: n=<n> measured, 3 warmups per scenario; resolution <w>x<h>

| Tier | p95 | Verdict | Gate |
|------|-----|---------|------|
| halo (cold) | __ ms | green/amber/red | <150 green / 150–400 amber / >400 or missing red |
| halo (warm) | __ ms | ... | same |
| ask | __ ms | ... | ≤2.5 green / ≤6 amber / >6 or missing red (proposed) |
| point | __ ms | ... | ≤2 green / ≤4 amber / >4 or missing red (proposed) |

Enablement on this platform: copilot=<disabled|opt-in|on>; pointing=<disabled|enabled>
Signed: <name> <date>
Re-measure triggers: Electron major, llama.cpp runtime or model change, display-stack/OS major update.
```

Default-deny rules: missing row, missing access, fewer than 30 measured samples, or a red halo tier ⇒ Copilot disabled on that platform. Amber halo ⇒ off by default with explicit opt-in and the "assistive, may be wrong" label. A red point tier with ask ≤ amber ⇒ answer-only variant, labeled, never points. Linux-only launch is the expected outcome unless other rows reach green.

## 8. M4.5 verification gates

1. Harness off: no `~/.omnia/latency` writes, no new allocations on the action path (unit test).
2. Harness on, fixture run: JSONL contains all four segment kinds, every line validates against §4.5, redaction allowlist test passes (no target text, no paths, no tokens).
3. Overlay ack: cold and warm `halo.paint` samples produced; missing ack downgrades to `painted:false` within 1000 ms and never delays the overlay (test with ack withheld).
4. Percentile unit tests: known arrays → known p50/p95, n=30, ties, n=1.
5. Report reproducibility: same raw JSONL → byte-identical report (stable ordering, no timestamps in body beyond header).
6. No network calls added: static check that the harness modules import no provider/network code; enabling it works with networking disabled.
7. Matrix §6 updated with access status before M5 planning; any row still red is recorded as disabled, not deferred silently.

## 9. Risks and unknowns

- **Paint ack is new UI plumbing** (overlay preload). Fallback if ack proves unreliable: label samples `halo.approximate` using `showInactive` + `ready-to-show` only; that weakens the green claim and must be noted in the decision record.
- **Non-streaming inference**: no TTFT baseline; do not claim first-token numbers.
- **`latencyMs` reuse hazard**: it includes cold load and ffmpeg; harness timers are new and additive, existing fields untouched.
- **macOS Metal-only correction**: earlier assumption "no Vulkan ⇒ CPU-only" is wrong for the catalog; the real unknown is whether the bundled Mac build exists/behaves and what Metal p95 is. Red until measured.
- **Hardware access is the critical path**, not code: rows 3–6 need borrowed machines or CI-adjacent runs; without them the decision record stays red by design.
- **Research context (marked estimate)**: published/derived numbers for 2B-class local vision on CPU are 8–60 s per grounding step; the code's own heuristic says ~29 s CPU. If those hold, point-tier green is realistically GPU/Metal-only, which is exactly what the harness exists to prove or refute. No measured UI-TARS-2B Q4_K_M number exists today.

## 10. Estimate

| Work | Days |
|------|------|
| Timers + wrappers (halo preload/ack, capture, providers) | 2.0 |
| Writer + setting/toggle + i18n + tests | 0.5 |
| Report generator + percentile unit tests | 0.5 |
| Per-platform run day (Linux now; others when access exists) | 0.5 each |
| **M4.5 total (Linux measured)** | **4–5** |

Parallel to M4; gates M5 scope. A platform without access contributes no days and no green.
