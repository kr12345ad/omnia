# Computer-use reliability model

The program contract is [`docs/computer-use-reliability.md`](../../../../docs/computer-use-reliability.md). This file
is the short, factual version of what shipped: the three failure modes that were fixed, the ref/generation
model, the aim strategies, the verification rule, how to run the harness, the measured numbers, and the
gaps that are still open.

**Line numbers.** Every `file:line` here was verified with grep on **2026-10-11**. This tree is being
actively edited by another session, so the numbers drift; the **symbol name is the stable anchor**. See §7.

The P0 this came from is recorded in `FOCUS_ROLLOUT.strategist.md` in this directory: a 0.4 semantic
over-match resolved a full-screen root element, its bounds-center was clicked at (960,539), Close was hit
instead of Minimize (9px apart), and the result reported **Verified**. Everything below exists so no code
path can reproduce that.

## 1. The three failure modes that were fixed

### 1.1 Semantic over-match — the 0.4 `query.includes(name)` clause

The old rule scored 0.4 whenever the *query* contained a short element *name*, and any score above 0 won.
A query naming `OC | Quick hello` therefore matched an element called `window` or `terminal`, resolved the
wrong element, and the router and provider disagreed about what was good enough.

The fix is one shared scorer, so a score the provider returns is always a score the router accepts:

| Rule | Where |
|---|---|
| `MATCH_THRESHOLD = 0.6` — the single floor | `match-score.ts:8` |
| `name.includes(query)` floors at **0.6**, never 0.4 | `match-score.ts:23` |
| exact match adds `+0.25` | `match-score.ts:26` |
| below the floor is **no match** (returns 0) | `match-score.ts:28` |
| router uses the same constant, not its own | `router.ts:547` (`SEMANTIC_SUFFICIENT_THRESHOLD = MATCH_THRESHOLD`), scored via `scoreMatch` at `router.ts:566` |
| provider rejects below its floor instead of returning a weak winner | `providers.ts:1219`, `providers.ts:1306` |

The tool layer refuses rather than ranking a weak match: `find.ts:171`, `read.ts:173`, `act.ts:428`,
`browser.ts:559`.

### 1.2 Blind bounds-center click

The old click path used the center of the resolved element's bounding box with nothing recorded about
where the point came from. The fix resolves the point from element metadata in a fixed order and labels
the one fall-through as a guess (see §3):

| Rule | Where |
|---|---|
| ordered strategies, bounds-center only as the last resort | `aim.ts:144` (`computeAim`), the guess itself at `aim.ts:158` |
| the single predicate that names a guess | `aim.ts:161` (`isCenterGuess`) |
| the safety layer reports the guess instead of letting the click pass quietly | `window-safety.ts:362` (`describeAimRisk`) |
| a centre guess on a titled control is `risk: "high"` | `window-safety.ts:468` |
| a named-window focus intent never reaches a provider at all | `service.ts:980` |
| the last resort grounds the window **body**, never the title strip, and records `aim: "bounds-center"` | `service.ts:1108` |
| the agent-facing tools surface the guess | `act.ts:751`, `snapshot.ts:174`, `find.ts:107`, `inspect.ts:234` |

### 1.3 false-Verified

The old path trusted the provider's own `verified` flag. The fix derives the verdict from a post-action
observation only:

| Rule | Where |
|---|---|
| `verified` only on a post-action observation that confirms it | `service.ts:721` (contract), `service.ts:737` (`confirmExecution`) |
| focus/activate confirmed against the title the **request** named, not the window the chain resolved to | `service.ts:771` (`confirmFocus`) |
| a ref action requires an observed state change versus the pre-action read | `service.ts:807` (`confirmRefChange`) |
| no observation is never a pass: `not_verified` + `no_post_observation` | `service.ts:783`, `service.ts:820` |
| engine level: a focus "move" is a change of **identity**, not of the scoped ref string | `engine.ts:305` |

## 2. The ref / generation model

A **ref** is the engine-minted identity of one element or window inside one observation. It is
`<base>@g<generation>` — the separator is a constant, `"@g"` (`engine.ts:31`), and every element and window
an engine accepts is re-minted with the observation's generation (`scopeSnapshot`, `engine.ts:492`;
`scopedRef`, `engine.ts:37`).

Properties that follow:

- **Stable within a generation.** Every ref, `windowRef`, `parentRef` and `focusedRef` in one observation
  carries the same generation suffix (`engine.ts:492-510`).
- **Never stable across generations.** Every capture is a new observation with a new generation, *even when
  the desktop did not change* (`engine.ts:162`): a generation tied to desktop state would let a ref from
  the previous observation still look current.
- **The generation-independent identity** is the base without the suffix (`refIdentity`, `engine.ts:44`).
  Readbacks and state deltas match on identity, because the after-observation necessarily minted new scoped
  refs for the same elements (`computeStateDelta`, `engine.ts:433-448`). Backend refs are content-addressed
  by occurrence index, so a shifted index is a different base and therefore a refusal, not a silent bind.
- **A stale ref is refused, naming both ids.** `resolveRef` throws `StaleRefError` for an unknown observation
  or a ref absent from it (`engine.ts:209`), and `refuseGenerationMismatch` refuses an action whose declared
  observation/generation pair does not match the one it runs against, with code `stale_ref`
  (`engine.ts:339`). The message names both sides — `observation X (generation N), not the current Y
  (generation M); re-observe before acting` (`staleBindingMessage`, `engine.ts:478`; the error class is
  `cua/types.ts:87` with `reason: "unknown_observation" | "absent_ref"` at `cua/types.ts:92`). The driver
  layer enforces the same rule as `target_stale` (`host-driver.ts:1245`, `host-driver.ts:1261`).
- **Refs are the primary targeting mode.** A ref + observation beats a semantic query; there is no
  rebinding by name. Same-name re-resolution is an explicit opt-in (`allowRebind`).

## 3. Aim strategies

`AimStrategy` is `aim.ts:8`. `computeAim` (`aim.ts:144`) tries them in this order and takes the first that
applies:

| Strategy | What it means |
|---|---|
| `provider-hint` | the accessibility provider reported a preferred click point for this element (`aimHint`) |
| `focus-point` | the provider reported the element's focus point (`focusPoint`) |
| `role-inset` | the role says where the actionable region is: title-bar buttons inset 12% from their group's edge (`aim.ts:32`, `aim.ts:120-131`), scrollbars inset along their thickness, toggle roles use their own center |
| `control-center` | the role names an actionable control (button, link, textfield, tab, treeitem, slider, …) whose box *is* the control, so its center is already exact |
| `bounds-center` | the element exposed none of the above. The point is the center of the reported bounds and **is a guess** |

`bounds-center` is flagged because it carries no evidence about where the control actually is. On a titled
window the control cluster sits in the title strip, where Minimize and Close are 9px apart — one ±10px
jitter step — so `evaluateClickRisk` returns `risk: "high"` for it (`window-safety.ts:468`),
`describeAimRisk` tells the caller to re-resolve (`window-safety.ts:362`), and every agent-facing tool
prints it as a guess (`act.ts:751`, `snapshot.ts:174`, `find.ts:107`, `inspect.ts:234`).

Pixel coordinates are for canvas/unknown surfaces only, never as a substitute for a resolvable control.

## 4. The verification rule

**A result is `verified` only when a post-action observation confirms it. Otherwise it is `not_verified`
with the observed state attached.** Absence of an observation is never a pass.

- `focus_window` / `activate_app`: the post-action active window (or its title, case-insensitive) must
  contain the title the *request* named, or be the window that title resolves to (`service.ts:771`). The
  window the action *claimed* to focus is reported as evidence of what was attempted, never as proof.
- An action on a resolved ref: the post-action observation must show a state change on that ref (focused /
  value / states) versus the pre-action read (`service.ts:807`).
- Anything else (vision points, keys) falls back to the execution's own verification record, which the
  bounded re-observe/retry path already refuses when it cannot confirm (`service.ts:730-732`).- No observation, or the element gone from it: `not_verified`, `reason: "no_post_observation"`
  (`service.ts:783`, `service.ts:820`).

## 5. Running the harness

```bash
# runnable gate — no display needed, exits 0 with a skip when it cannot run
cd packages/omnia && bun run test:computer-use
```

`test:computer-use` is `bun test src/computer-use/live-harness/ src/computer-use/`
(`packages/omnia/package.json:17`). It covers the live-harness trials and every computer-use test,
including the end-to-end reliability claims in `reliability-e2e.test.ts`. On 2026-10-11 that was
**321 pass / 0 fail**, but the tree was being edited during the run — read the result against §1-§4, not
against a remembered count.

Running the directory in one `bun test` invocation is the documented path; running the files one at a time
also works. If a single file shows failures that the combined run does not (or vice versa), file an
investigation rather than picking the answer you prefer.

The real-desktop run is a separate CLI and needs **both** an arm and a display
(`live-harness/desktop-gate.ts:21`, `live-harness/run.ts:56`):

```bash
cd packages/omnia
OMNIA_LIVE_HARNESS=1 DISPLAY=:0 bun ./src/computer-use/live-harness/run.ts
```

Two independent gates, both explicit:

1. `OMNIA_LIVE_HARNESS=1` — without it `createLiveAdapters` returns `undefined` and **no driver is ever
   constructed**, so an unarmed process cannot move a pointer.
2. A non-empty `DISPLAY` — without it the CLI still refuses rather than synthesising input into nothing.

Unarmed or displayless it prints `skip: no desktop (<reason>)` and exits 0. It never fabricates a result it
did not observe. Override the target window and control with `OMNIA_LIVE_HARNESS_WINDOW` /
`OMNIA_LIVE_HARNESS_CONTROL` (`run.ts:36-44`); point it at a scratch window, not at work — when armed, the
trials perform real actions on the desktop they find.

The four trials and the guards they assert live in `live-harness/`: focus (active window must contain the
named title), wrong-target (no blind screen-center click on an off-center target, and the click must land on
the named control, and stay clear of the Close guard), honest-verify (a change-free action may only claim
`not_verified`), and stale-ref (a stale ref is refused and never clicks another element). The guards are
`assertNotCenterClick` (`assertions.ts:86`), `assertVerifiedOnlyOnChange` (`assertions.ts:226`) and
`assertStaleRefRefused` (`assertions.ts:253`).

## 6. Measured numbers

Host: **Rocky Linux 9.8 (Blue Onyx), x86_64, 20 cores, 22 GB RAM, KDE Plasma on X11 at 1920×1080** — the
same repro environment the P0 was documented on. Measured with `bun test
src/computer-use/latency-budget.test.ts` (`latency-budget.ts:24` step budget 2000 ms, `:27` desktop sizes
50/200/500/1000, `:35` 15 measured runs after 3 warmups, `:38` 3 changed controls).

Re-measured on 2026-10-11. The 200-control row is reproducible to the char; the timings move with the tree,
so treat them as bands.

| Scenario | Result |
|---|---|
| Diff payload, 200 controls, 3 changes | **147,436 → 141 chars** (1046× smaller), diff p50 0.20 ms; `changed=3 moved=0 unchanged=221` (`latency-budget.test.ts:264`) |
| Deterministic step, 50 → 1000 controls | **1.7 → 5.3 → 13.5 → 27.2 ms** (median of 15 runs; `latency-budget.test.ts:381`). An earlier run of the same test on the same host gave 1.63 → 4.88 → 12.5 → 23.44 ms, so quote this as "single-digit ms at 200 controls, low tens at 1000". |
| Live AT-SPI observe | **p50 31.0 ms** on 2026-10-11 (46 elements, 23,433 chars). Across six runs of this test on this host the p50 was 29.5–50.8 ms; the number recorded when the program closed was 35.9 ms. Treat the live capture as **~30–50 ms**, not a constant. |

Also measured on the same host, for context: X11 window list p50 9.5 ms, semantic find p50 1.0 ms, XTest
input round trip p50 20.8 ms (a click performs two). Adding real input injection to the deterministic step
gives 47–73 ms across 50–1000 controls — still inside the 2000 ms budget, which is dominated by the capture
and the input channel, not by our code.

## 7. Known gaps

Read from the repo, not from the contract. Nothing here is fixed.

**How to read the citations.** Every `file:line` in this file was verified with grep on **2026-10-11**
against the then-current working tree. Another session was editing these files while this file was written,
so the line numbers are a snapshot, not a constant. The **symbol name is the stable anchor** — if a number
looks wrong, search the file for the identifier named next to it before assuming the rule moved.

**Platform coverage**

- **Linux / AT-SPI exposes only what registered.** The walk only sees applications that registered on the
  accessibility bus. Native X11 clients and toolkits with the bridge disabled never appear there, so a
  snapshot whose only records are X11 window frames has no text field and no button — nothing an agent can
  act on but focus. The backend widens the scope once when the narrowed walk comes back empty
  (`cua/backends/linux.ts:1490`), but a fully non-atspi desktop is still an empty tree.
- **macOS Swift helper is unverified.** The native AppKit/ApplicationServices helper
  (`cua/backends/darwin-ax.ts:1`) is written against the AX API and compiled with `swiftc` at runtime
  (`cua/backends/darwin.ts:1207`, `cua/backends/darwin.ts:1221-1230`), but it has never been run on macOS
  hardware: no live capture, no measured observe latency, no verified role vocabulary. Treat every darwin
  number as absent.
- **Windows PowerShell path is unverified.** The UIAutomation scripts (`cua/backends/windows-script.ts:35`
  onward) are code-reviewed only. No live run, no measured latency, no confirmed selector or role mapping.
- **Latency numbers are Linux-only.** `latency-budget.ts` measures Linux hosts; the per-platform matrix in
  `specs/v27/latency-harness.md` is default-deny and every non-Linux row is red by design.

**Behaviour still open**

- **The live harness real-desktop arm has never been executed.** Its gates are tested (unarmed and
  displayless runs report a skip and build no driver — `live-harness/desktop-gate.ts:21`,
  `live-harness/run.ts:56`), but the path that constructs a real `CuaHostDriver` has not been driven on this
  host, because doing so clicks real title-bar buttons. Run it yourself against a scratch window before
  trusting it.
- **`actionForOperation` still derives a pixel point from bounds** for the semantic provider
  (`providers.ts:1310-1315`). That is the sanctioned pixel path (canvas/unknown surfaces and the
  vision-grounded window body), but it is the same arithmetic the P0 came from, so any new caller that
  reaches it without a resolved ref or a recorded aim strategy reintroduces failure mode 1.2.
- **`bun test src/computer-use/` passes today, but it is a moving target.** At the time of writing it was
  321 pass / 0 fail; two of those tests were failing hours earlier and the other session is still editing
  the same files. Re-run it and read the failures against §1-§4 above rather than against this sentence.
- **No test pins the tool layer's imports.** `reliability-e2e.test.ts` covers the stack end to end but
  drives the service, not the `packages/opencode/src/tool/computer` tools. A locally re-implemented
  threshold or a locally computed aim point in that folder would not fail any test — see the AGENTS.md
  note there.

**Fixed since this program started, recorded so they are not "re-found" as bugs**

- The manager used to discard the fresh reference that revalidation returned, so a valid element-ref action
  was refused with nothing delivered. It now dispatches against that reference; a ref bound to an
  observation that is no longer current is still refused, naming both observations.
- The engine used to count a focus "move" whenever the scoped ref string changed, which every capture did,
  so a change-free action verified. `focusedMoved` now compares `refIdentity` (`engine.ts:305-309`).
- The audit journal now carries the aim point and strategy, the observation/generation pair, and the window
  title a window action named (`security/journal.ts`, the `ComputerUseRecord` shape; mapped at
  `server/server.ts:161-167`).
