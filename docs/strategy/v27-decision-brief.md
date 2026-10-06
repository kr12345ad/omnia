# Omnia v27 — Decision Brief: Top-5 Features, Differentiation, Resequence Triggers

**Status:** active decision brief · **Owner:** strategist · **Date:** 2026-09-27
**Basis:** v27 feature room (3 rounds; manager decision + specialist follow-ups). Companion artifacts: builder M1 RFC (gate/leases/journal), researcher M4.5 latency-harness spec, critic week-1 capture contract. Repo facts in §7 verified against branch `dev` @ `7c7292de41` on 2026-09-27.

---

## 0. Decision

Omnia v27 ships five features in dependency order: **trust spine → rehearsal → skills → copilot → fleet.**

| Rank | Feature (IDs) | Experience | Effort |
|---|---|---|---|
| 1 | Permission Leases + Flight Recorder (P2/P5) | Trust Contracts | S/M |
| 2 | Shadow Run Rehearsal + Two-Key / Panic Stop (P1/P13) | Rehearsal Theater | M |
| 3 | Teach-by-Demonstration → Self-Healing Replay (P3/P4) | Teach Me Once + Healed Diff | M/L |
| 4 | Screen Copilot, latency-gated (P6) | Halo Spotlight | M |
| 5 | Fleet Mission Control (P9) | Mission Control | L |

Deferred: P7 Budget Governor (basics fold into M1), P8 Omnia Daemon, P10 Scheduled Room Auditor, P11 Vault Login Assistant, P12 Phone-as-Approver, P14 Context Pins, P15 Skill Packs (basic export/import may ride with M4).

**Reasoning in one paragraph.** Competitor verification kills the strong-form claim: real-desktop control is no longer unique (ChatGPT desktop Computer Use, Manus Desktop "My Computer", Rabbit DLAM, Microsoft Copilot Actions, Anthropic Cowork/Code research preview all reach real desktops as of 2026). What survives, verified "none found" in the 11-rival set, is (a) a user-held local control plane — expiring leases plus an on-device tamper-evident journal, (b) offline teachable, self-healing GUI skills, and (c) orchestration of several user-owned machines with per-machine leases. v27 builds exactly those three, cheapest-dependency-first.

**Global acceptance.** One `gate()` drains every action path; zero ungated dispatch. Journal JSONL persists every decision with rotation and a zero-leak redaction fixture. Leases expire server-side with the UI killed. Rehearsal emits zero driver input. Two-Key is a release gate for the milestone. The capture contract passes all six items. Latency: green <150 ms p95 enables; amber 150–400 ms ships off-by-default; red/no-data disables per platform. Fleet caps at three machines, per-machine leases, no silent retries. No telemetry; no new cloud dependency for control, secrets, memory, or skills.

---

## 1. Top-5 rationale

### 1.1 Permission Leases + Flight Recorder — "Trust Contracts" (P2 + P5, S/M)

**User problem.** Per-action permission prompts exhaust users who want bounded autonomy; after a run, nobody can prove what the agent actually did.

**What ships.** Server-enforced scoped leases (`{scopes[], computerId, app, ttl, usesRemaining, oneShot}`) with countdown, one-click revoke, and audit trail. Append-only local journal of every gate decision (`ts, lease_id, action, decision, redaction_hash, before_ref, after_ref`), with a timeline scrubber and exportable incident report. This converts safety into positioning: the audit trail is itself a differentiator.

**Architecture fit.** The gate is currently aspirational, not actual: exactly 7 production `permissions.evaluate` call sites in 2 files (`server/computers.ts:862, 1533, 1650, 2597`; `server/api.ts:809, 1220, 1257`) and 3 paths bypass it — browser actions short-circuit before the permission block (`computers.ts:853`; `executeBrowser` at `:1999` never evaluates `BROWSER`), `POST /v1/computer-use/analyze` has no evaluation (`api.ts:1019`), and `POST /v1/computers/:id/observe|find` accept unguarded reads (`api.ts:459`). Two dead-but-designed subsystems make M1 cheaper: `security/approval.ts` already models `ApprovalGrant` with `expiresAt`/`usesRemaining`/`fingerprint` (never wired), and `security/audit.ts` defines `AuditTrail` plus redaction/danger event factories (never instantiated). Journal attaches at the SSE `EventBus` (`server/events.ts`, today a 512-entry in-memory ring); JSONL gives it durability. UI: lease cards in the composer, journal scrubber in the session panel (packages/app + session-ui).

**Dependencies.** None; root of the tree. `computerId` is in the lease schema from day one so remote machines inherit it.

**Risks.** Over-broad grants (mitigate: conservative defaults — `SECRETS` denied, shortest TTL, no persistent by default); journal PII (rotation + redaction fixture); scope smuggling via caller-supplied `approve:true`/`approvedScopes` at the server boundary (mitigate: only the server's own gate may approve; tool callers lose self-approval).

**Acceptance.** Single gate; zero ungated dispatch; lease expiry holds with UI killed; redaction fixture clean.

**Why rank 1.** Cheapest (S/M); unlocks every later autonomy feature; and no rival found ships a user-held expiring lease plus an on-device journal.

### 1.2 Shadow Run Rehearsal + Two-Key / Panic Stop — "Rehearsal Theater" (P1 + P13, M)

**User problem.** Users won't let an unverified agent touch their machine, and destructive steps (delete, pay, send, sudo) are one model slip away.

**What ships.** A dry run of a plan against the live screen with zero input events: risk-tagged step list, predicted diff, batch approval, low-risk classes skipping prompts, mandatory execute-time re-validation. Two-Key confirmation (typed phrase or held key) for classified destructive actions; double-Escape global panic stop cancels queued actions and revokes leases.

**Architecture fit.** The gate gains a `simulate` mode: every step resolves, no driver call fires (proven by counter). `computer_visual` `ground` already locates without clicking. Two-Key classifies against the existing danger taxonomy; the overlay + input-freeze loop (`desktop/src/main/omnia/overlay.ts`, `agent-working.ts`, `daemon/input-grab-script.ts` with `INPUT_ESCAPE_WINDOW_MS = 700`) already implements freeze/release for the panic path. Rehearsal plan renders as a timeline card.

**Dependencies.** M1 (gate, leases, journal).

**Risks.** Plan/execute divergence — a Monday rehearsal may not match Tuesday's screen (mandatory execute-time re-validation; stale approvals invalidate); approval fatigue (risk classes, batch grants); Two-Key false positives or bypass (conservative classifier; coverage tests as a release gate).

**Acceptance.** Rehearsal emits zero driver input (counter test); stale approvals invalidate; Two-Key ships as a release gate, not a rider.

**Why rank 2.** One-of-a-kind: "watch before it acts." A cloud VM structurally cannot offer it, and it is what makes the skills moat permissible.

### 1.3 Teach-by-Demonstration → Self-Healing Replay — "Teach Me Once" + "Healed Diff" (P3 + P4, M/L)

**User problem.** Only power users can author superskills; hand-made macros shatter when a UI changes.

**What ships.** Record a workflow once (with consent and input-freeze banner), compile to an editable, parameterized local skill with semantic targets; replay via semantic anchors with local UI-TARS re-ground fallback; abort after two failed re-grounds; when a step heals, show a confidence-scored Healed Diff receipt and bump the skill version.

**Architecture fit.** Superskills exist end-to-end: JSON store at `~/.local/share/omnia/superskills.json`, JSON-RPC bridge (`superskills/bridge.ts`), gated call route (`api.ts:809`), create-with-AI flow (`app/src/components/settings-superskills.tsx`). Capture rides the desktop drivers; replay rides the gate in leased execute mode. The one genuine unknown is the semantic step-segmentation schema across AT-SPI/AX/UIA — gated by the critic's 5-day contract as M3 week 1, with fallback ladder: user-marked boundaries; Linux/AT-SPI-only MVP; cross-platform deferred.

**Dependencies.** M1 gate/journal; superskill schema. Skill Pack signing/export can ride M4 but is not required for the moat.

**Risks.** Capture leakage is the single most trust-breaking bug in v27 — P0: hard-exclude `SECRETS`/`CLIPBOARD_READ`, CI redaction fixture, manual review of every draft. Silent misclicks on repair (abort after two failures; always surface the diff). Model license review before redistributing UI-TARS/Moondream artifacts in packs.

**Acceptance.** 10-step task records and replays on 3 apps; abort-after-two verified; ≥70% repair rate on drifted-UI matrix.

**Why rank 3.** Flagship moat — local, teachable, self-repairing GUI skills are data no cloud can absorb, and "none found" in the rival set. It stays third because it depends on the trust spine and carries the biggest unknown: order is dependency-driven, not novelty-driven.

### 1.4 Screen Copilot — "Halo Spotlight" (P6, M)

**User problem.** Users want spot answers ("what does this error mean?", "where do I click?") without starting a full agent run and without uploading their screen.

**What ships.** Hotkey summons local vision: Moondream answers about the screen, UI-TARS grounds the target, the halo spotlights it; nothing is clicked unless a lease is granted. Latency HUD makes local performance visible; egress stays zero.

**Architecture fit.** Bundled CPU+Vulkan llama.cpp; `computer_visual` `question`/`ground`; existing overlay window and input-freeze loop; M4.5 latency harness (SSE instrumentation, p50/p95 report, per-platform hardware matrix) gates enablement default-deny.

**Dependencies.** M4.5 harness (4–5 days, parallel); per-platform local vision viability.

**Risks.** Accuracy flaps read as system errors (label "assistive, may be wrong"; pin UI-TARS as locator); CPU latency on macOS (no Vulkan) and unverified Windows path (Linux-first, disabled elsewhere until measured); overlay >150 ms (off by default).

**Acceptance.** Green <150 ms p95 enables; amber 150–400 ms off-by-default; red/no-data disabled per platform (missing hardware counts as red).

**Why rank 4.** Adoption flywheel and the most visible demo value, but not the moat — and it carries the most unmeasured platform risk, so it must not lead.

### 1.5 Fleet Mission Control — "Mission Control" (P9, L)

**User problem.** Users own several computers (desktop, laptop, work box) and no agent spans them; running the same task everywhere is manual.

**What ships.** One session orchestrating up to three paired machines with per-machine leases, a single timeline, live health, fleet-wide panic stop, and unpair-and-purge. Deploy on Linux, verify on macOS — one operator, many machines.

**Architecture fit.** Pairing (10-minute single-use codes, `pairing/manager.ts`), remote queue/long-poll (`server/remote.ts`), RemoteAgent CLI (`remote/cli.ts`, `remote/agent.ts`), subagent/task model. Per-computer bearer tokens exist but have no TTL beyond a 90-second staleness reap; v27 adds revocation semantics aligned with leases (`computerId` present since M1).

**Dependencies.** M1 per-computer leases; remote hardening; M3 skills make fleet missions genuinely useful.

**Risks.** Blast radius multiplies (3-machine cap, per-machine leases and panic stops, no silent retries, visible partial failure); remote state corruption on partial failure (acceptance: remote state untouched and visibly red); token lifetime (add revocation).

**Acceptance.** Cross-OS task completes or fails safely with full per-machine audit.

**Why rank 5.** Category expansion no rival in the 11 matches, but it amplifies every upstream weakness — so it ships last and capped.

---

## 2. All-11-rival claim table

Method: web-verified September 2026; "V" = verified to a source in §9, "U" = unknown/unverified, "NF" = none found. Absence claims are evidence-of-search, never proof of non-existence. Two claims carry the moat and were searched explicitly: **offline teachable GUI skill replay** and **multi-device orchestration**.

| Product — positioning | Deployment | Real-desktop control | Offline | Permission model | Teachable GUI skills (record → replay) | Multi-device | Evidence |
|---|---|---|---|---|---|---|---|
| **OpenAI Operator / ChatGPT agent** — cloud browser agent that became a local desktop agent | Operator/ChatGPT agent 2025: remote cloud browser/VM [1][5]; ChatGPT Work desktop Computer Use macOS/Win Jul 2026 [2][3] | **V — yes now** (desktop Computer Use; Windows foreground-only, macOS background/locked) [2][3] | No — cloud models [2][3] | Per-app approval cards + "Always allow"; auto-review; admin controls; "Important actions" default [3][6] | NF (no record/replay feature found) | NF | V [1][2][3][4][5][6]; teachable + multi-device NF |
| **Anthropic Computer Use** (+ Cowork/Code, Chrome) — API toolset; you supply the machine | API toolset run by your app; reference Docker/Xvfb container [7][8]; Cowork/Code desktop local sessions [9][14] | **Partial — developer-wired**; dedicated VM/container recommended [7]; Cowork/Code screen control = research preview, per-app consent [9] | No [7][9] | App-implemented; human confirmation before consequential actions per docs [7]; Cowork/Chrome: per-app/site + classifier auto-approve, "skip all permissions" option [9][11][12] | NF (Skills are text instructions, not GUI replay) | NF (Cowork syncs web/desktop/mobile; not multi-computer orchestration) [10][14] | V [7]–[12],[14]; teachable + multi-device NF |
| **Claude Code** — local coding agent (terminal/files) | Local CLI/desktop; optional cloud and SSH sessions [10][14] | No — terminal/file/code control, not GUI [10][14] | No official; third-party local-model endpoint documented (experimental) [15] | allow/ask/deny rules + sandbox + permission modes [13] | NF (text skills/rules only) | NF (SSH/remote sessions; mobile Remote Control to one CLI) [10] | V [10][13][14]; offline partial via third party [15] |
| **Cursor** — local AI code editor + cloud agents | Local editor (Anysphere); Cloud Agents in isolated cloud VMs; Self-Hosted Machines: loop cloud, tools local [16][17] | No — editor/terminal only | No — prompts/code sent to model providers [16] | Per-command approvals by default; MCP per-invocation approval; Cloud Agents auto-run (3rd-party guide) [17][18] | NF | NF | V [16][17]; auto-run nuance [18] third-party |
| **Devin (Cognition)** — autonomous cloud engineer with its own desktop | Cloud Linux VM (Windows beta May 2026); macOS only via Outposts on customer hardware [19][21][23] | **Partial** — controls its own cloud desktop; Outposts can use the machine's existing session, not an end-user PC [19] | U (no evidence found) | Autonomous; network-access requests; takeover; no per-action model [19][20] | NF for GUI demo replay (Playbooks/Knowledge/Skills are text, auto-generated from sessions) [22] | NF — parallel Devins run in isolated cloud VMs, not user computers [22] | V [19][20][21][22][23] |
| **Manus** (now Meta-owned) — cloud agent with local browser/desktop reach | Cloud VM + Cloud Browser [24]; local browser extension [25]; Manus Desktop "My Computer" local apps Mar 2026 [26] | **Yes via My Computer** — reads/edits files, launches/controls applications locally; otherwise browser-only [26] | NF (no evidence) | Explicit approval per task (Allow Once / Always Allow); one-time browser authorization; takeover [25][26][27] | NF | NF (session/cookie sync; Wide Research = parallel cloud agents) [27] | V [24][25][26][27] |
| **Rabbit r1** — pocket device whose LAM now drives your PC | Device + cloud LAM (headless) [30]; DLAM: USB + browser page, "no virtual machines," controls Win/Mac [28][29] | **Yes via DLAM** — operates the user's desktop via screen share [28][29] | No — computation offloaded to data centers [30] | Screen-share grant; no per-action approval model documented [28][29] | **Partial** — Teach Mode records demonstrated web tasks in cloud Rabbithole and replays via r1; cloud/web-only, beta; 2026 status unknown [31] | NF | V [28][29][30][32]; teach-mode current status U |
| **Microsoft Copilot Actions / Copilot Studio computer use** — local isolated workspace + managed-machine CUA | Copilot Actions on local PC in isolated Agent Workspace/separate account (opt-in, Copilot Labs) [35][36][37]; Studio computer use runs on a Windows machine you configure; Windows 365 cloud PC via MCP [33][34] | **Partial** — acts on your PC but inside a separate agent session/workspace; Studio targets a configured machine, not your interactive desktop [33][35][36] | No | Consent/opt-in, scoped folders; Studio: access allowlist, human supervision, stored credentials; instructions can waive confirmations [33][35][36] | NF for the named products (prompt instructions only); adjacent Power Automate Desktop recorder does local record→replay [38][39] | NF | V [33]–[37]; teachable/multi-device NF |
| **Open Interpreter** — local open-source code/shell agent with experimental OS mode | Runs locally (terminal/desktop app) [40][43] | **Yes** — executes on your machine; OS mode controls mouse/keyboard (experimental, current support unknown) [41][42][44] | **Yes — fully local** with Ollama/LM Studio etc. [40] | Confirmation before code execution; `-y`/auto_run bypass; sandbox + approval modes [41][43] | NF (Skills = reusable text workflows) [43] | NF | V [40][41][42][43][44] |
| **Agent S (Simular)** — open-source computer-use framework; commercial sibling Sai | Runs locally on user machine (Linux/Mac/Win, pip) [45] | **Yes** — mouse/keyboard/screen control of real GUI [45] | **Partial/U** — grounding model can be hosted locally; full local reasoning not verified [45] | None built-in ("runs Python code to control your computer — use with care") [45] | NF (experiential knowledge base, not user-recorded replay) [45] | NF for Agent S; commercial Sai claims one-or-multiple computers (vendor press release) [46] | V [45]; Sai claim vendor-sourced [46] |
| **Mobile-Agent (Alibaba/X-PLUG)** — open GUI-agent family for phones (and PC) | Local host controlling Android via ADB (or cloud phone); GUI-Owl open weights served via vLLM `--base_url` [47][48] | **Yes for device GUI** — Android/Harmony; earlier PC-Agent/OSWorld desktop paths [47][48] | **Partial** — open weights servable locally; full offline not explicitly documented [47][48] | None built-in (ADB debugging access) [47] | NF (Mobile-Agent-E has self-evolving memory/Tips) [49] | NF (multi-agent = roles on one device) [47][49] | V [47][48][49] |

### 2.1 Surviving claims vs. refuted claims

| Omnia claim for v27 | Status after verification | Nearest rival reality | Label |
|---|---|---|---|
| User-held local control plane: expiring leases + on-device tamper-evident journal | **Survives** | ChatGPT desktop CU, Manus My Computer, Copilot Actions, Rabbit DLAM, Cowork all touch real desktops; none found with user-held expiring leases + local journal | none found |
| Offline teachable, self-healing GUI skill replay | **Survives** | Rabbit Teach Mode = cloud/web beta; OpenAdapt/GPA are adjacent outside the 11, no agent reasoning, no gate | none found in the 11; adjacent implementations exist |
| Multi-device orchestration of the user's own computers, per-machine leases | **Survives** | Simular Sai press-release claim, Lenovo Qira, UFO3 research; no named product ships it | none found in the 11; adjacent claims exist |

**Claims that must not ship in messaging** (falsified by this pass):

- "Only Omnia controls your real desktop." False since 2026. ChatGPT desktop Computer Use (macOS/Windows, approvals, scheduled tasks), Manus Desktop "My Computer", Rabbit DLAM, Microsoft Copilot Actions, and Anthropic Cowork/Code research preview all reach real desktops.
- "No cloud." False as stated — provider inference may use cloud APIs. Ship: "no cloud for control, secrets, memory, skills."
- "Rivals can't record and replay a taught workflow." False as stated — Rabbit Teach Mode records and replays, but in vendor cloud, browser-only, beta, 2026 status unknown. The defensible claim is **offline, on-device, self-healing, lease-gated replay**.

### 2.2 Adjacent implementations to watch (outside the 11)

- **OpenAdapt / OpenAdapt Flow** — local deterministic record→replay of demonstrated GUI workflows, no model calls on healthy replay. Closest existing thing to Teach Me Once; no permission gate, no agent reasoning, not productized on this stack.
- **Salesforce GPA (research)** — single-demo GUI record-and-replay.
- **Power Automate Desktop** — local recorder, Windows-only, adjacent Microsoft product.
- **Simular Sai (vendor claim)**, **Lenovo Qira (CES 2026)**, **UFO3 (research)** — cross-device/fleet delegation claims.
These are why the brief says "none found in the 11," and why the wedge must be safety-integrated replay, not replay alone.

### 2.3 Competitor classes and our edge

| Class | Rivals | Honest gap (what they do better) | Our edge |
|---|---|---|---|
| Cloud CUAs | Operator/ChatGPT agent, Anthropic CU, Manus, Devin, Rabbit | Frontier model quality, polish, scale, background/locked-screen execution on macOS | Local control plane; leases + on-device journal; offline; secrets never leave the vault; per-machine fleet |
| Code-scoped | Claude Code, Cursor | Deep code/repo tooling, sandboxing, cloud parallelism | GUI workflows; teachable local skills; cross-app orchestration; they complement, not cover |
| OS-tied | Windows Copilot agents | OS integration, managed workspaces, enterprise policy | Cross-OS; acts on the user's interactive desktop, not an isolated agent workspace; user-held leases |
| Local OSS | Open Interpreter, Agent S, Mobile-Agent | Free, code-first, research depth | Server-side permission gate, leases, journal, vault, productized skills, multi-OS drivers |
| Adjacent RPA | Power Automate Desktop, OpenAdapt | Mature deterministic replay | Agent reasoning + local vision + self-healing + permissions |

---

## 3. Named experiences (positioning vocabulary)

| Name | Feature | One-liner |
|---|---|---|
| **Trust Contracts** | P2 + P5 | Scoped, expiring, locally revocable permission leases with a tamper-evident local journal. |
| **Rehearsal Theater** | P1 + P13 | Dry-run the agent against a shadow desktop: predicted diffs, zero input, risky steps gated. |
| **Teach Me Once** | P3 | Demonstrate a workflow once; Omnia compiles an editable, parameterized local skill. |
| **Healed Diff** | P4 | When a UI changes, replay heals locally and shows a confidence-scored, versioned repair receipt. |
| **Halo Spotlight** | P6 | Hotkey local copilot answers about the screen and spotlights targets — zero egress, latency HUD. |
| **Mission Control** | P9 | One console, up to three paired machines, per-machine leases, fleet panic stop, local journals. |

Positioning line: **"The agent that asks permission, shows its work, and learns your machine — on your machine."**

---

## 4. Proof-demo scripts

Run on a Linux desktop with the v27 AppImage; `[verify]` marks anything not yet confirmed on reference hardware. Every demo must pass its numeric metric before external use.

### 4.1 Trust Contracts — Permission Leases + Flight Recorder

**(a) Claim.** Every Omnia action is covered by a scoped, expiring, locally revocable lease and recorded in a tamper-evident local journal.

**(b) Setup.** Linux, v27 AppImage, fresh profile; Calc with `budget.ods` [verify]; Leases, Flight Recorder, network monitor open.

**(c) Steps.**
1. Leases panel: "No active leases — control denied."
2. Ask Omnia to fill the March column; gate returns `permission_required`.
3. Request lease: `files:write`, `~/Demo/budget.ods`, TTL 5 min, one-shot.
4. Approve in the server-side gate, not the renderer; card counts down.
5. Edit runs; chip shows "1 of 1 used", then expires.
6. Flight Recorder by lease ID: tool, target, result, timestamp, hash.
7. Revoke a second lease mid-task; action halts.
8. Re-run; gate denies.
9. Export `flight-recorder.jsonl`; Verify chain → OK.
10. Network monitor: 0 bytes egress.

**(d) Artifact.** Lease cards with countdown/revocation; hash-chained journal; "chain OK"; zero egress.

**(e) Pass metric.** 100% of actions under an active lease; 0 after revocation; 0 broken links; 0 bytes egress.

**(f) Contrast.** Cloud rivals cannot show this: their control plane runs in vendor infrastructure, so users can't hold a lease, revoke locally mid-task, or read a signed offline journal — revocation is a support ticket, not a keystroke.

### 4.2 Rehearsal Theater — Shadow Run + Two-Key/Panic Stop

**(a) Claim.** Taught workflows dry-run against a shadow desktop — predicting diffs and stopping at risky steps — before touching real state.

**(b) Setup.** Linux, v27; skill "Monthly Close" [verify]; Rehearsal Theater; `budget.ods`; panic key Esc Esc [verify].

**(c) Steps.**
1. Skill Library → "Monthly Close" → Rehearse.
2. Theater: 14 predicted actions; 3 flagged risky (delete, overwrite, send).
3. Start 1x; shadow overlay traces targets; side panel monitors real mtimes.
4. Step 6 pauses for Two-Key approval via Discussion Room [verify].
5. Deny; step skipped; shadow continues.
6. Diff: 5 would-change cells, 1 blocked delete.
7. Panic Stop mid-run; shadow freezes <1 s [verify].
8. Resume, finish; Rehearsal Report shows confidence and blocked steps.
9. Promote to live; plan reruns under a real lease.

**(d) Artifact.** Rehearsal report; unchanged-mtime proof; panic-stop timestamp.

**(e) Pass metric.** 0 real files mutated; 100% steps predicted; risky gate catches 3/3; stop <1 s [verify]; report <=30 s.

**(f) Contrast.** Cloud rivals cannot show this: their agents execute live against APIs/screens, with no shadow substrate, no predicted diff, no local freeze, and no zero-write proof — "dry run" is a prompt, not enforced state.

### 4.3 Teach Me Once — Record a Workflow

**(a) Claim.** Demonstrate a workflow once and Omnia compiles it into an editable, parameterized local skill that replays on demand.

**(b) Setup.** Linux, v27; browser with an expense form [verify]; Recorder ready; no cloud account.

**(c) Steps.**
1. Teach Me Once → Record; input-freeze banner, recorder badge pulses.
2. Perform: open browser, fill 4 fields, attach receipt, submit [verify form].
3. Stop; Omnia compiles 11 events into a skill.
4. Skill Editor: semantic targets (label, role), not coordinates; fallbacks listed.
5. Parameterize `{{amount}}`, `{{today}}`.
6. Add a superskill bridge method (JSON-RPC) for submit [verify].
7. Save to local Skill Library; show plain-JSON path.
8. Run with `amount=42.50`; second expense submits.
9. Receipt: 11/11 steps, duration, lease used.
10. Network monitor: 0 bytes egress [verify vision use].

**(d) Artifact.** Skill JSON with selectors/parameters; bridge method; run receipt; on-disk path.

**(e) Pass metric.** Record→replay >=9/10 [verify]; 0 coordinate-only steps; one-field parameter edit; file <10 KB.

**(f) Contrast.** Cloud rivals cannot show this: demos stream to vendor recorders, skills live in vendor tenants, edits mean re-prompting; Omnia records, compiles, stores, and replays on disk with no egress.

### 4.4 Healed Diff — Self-Healing Replay Receipt

**(a) Claim.** When a replay breaks on UI change, Omnia heals the failed step locally and shows a reviewable diff with confidence — no re-recording.

**(b) Setup.** Linux, v27; skill from Teach Me Once; pre-arranged rename "Submit"→"Send expense" [verify]; Healed Diff viewer.

**(c) Steps.**
1. Run skill; step 7 fails: "target not found: Submit".
2. Self-heal scans via local UI-TARS [verify]; proposes "Send expense".
3. Healed Diff: old step (selector + crop) vs proposal; confidence 0.94 [verify].
4. Candidate highlighted live.
5. Approve; skill updated, diff stored.
6. Replay resumes; 11/11.
7. Healing Receipt: failed step, candidate, confidence, approver, hash.
8. On-disk skill now holds the new selector; history v1→v2.
9. Re-run from scratch; persists.
10. Set confidence floor 0.90; sub-floor needs approval [verify].

**(d) Artifact.** Old-vs-new diff with confidence; hashed receipt; versioned skill JSON.

**(e) Pass metric.** Heal <=1 attempt; review <=30 s; 100% sub-floor gated; 0 cloud calls.

**(f) Contrast.** Cloud rivals cannot show this: their automations fail hard or silently in the cloud, with no local diff, no confidence score, no signed receipt, and no inspectable on-disk version.

### 4.5 Halo Spotlight — Latency-Gated Screen Copilot (Linux-first)

**(a) Claim.** A hotkey summons a local vision copilot that answers screen questions and grounds targets in under a second, with a latency HUD and zero egress.

**(b) Setup.** Linux (Wayland + X11) [verify]; bundled llama.cpp CPU+Vulkan, no CUDA/ROCm, to prove baseline; latency HUD, network monitor on.

**(c) Steps.**
1. Settings → Vision: llama.cpp; Moondream Q&A, UI-TARS grounding; egress "off".
2. Press Ctrl+Shift+Space [verify]; halo appears, input freezes.
3. Ask "What does this error mean?"; Moondream answers.
4. HUD shows first-token and total latency.
5. Ask "Click Retry"; UI-TARS returns a box; halo draws it.
6. Enter clicks under a lease; Retry fires.
7. Install CUDA build [verify]; repeat for HUD improvement.
8. Ten queries; HUD p50/p95; egress still 0.
9. Wi-Fi off; query still works.
10. Dismiss; input freeze releases.

**(d) Artifact.** Halo answer + bounding box; latency HUD; zero-egress graph; success offline.

**(e) Pass metric.** p50 <=800 ms, p95 <=1.5 s [verify]; 10/10 offline; 0 bytes egress; grounding >=9/10 [verify].

**(f) Contrast.** Cloud rivals cannot show this: pixels must be uploaded, so they cannot run with Wi-Fi off, publish a local p95, or prove zero egress — their copilot dies with the network.

### 4.6 Mission Control — Multi-Machine Orchestration (max 3, per-machine leases)

**(a) Claim.** One operator runs a mission across up to three paired machines, each under its own lease, and stops everything from one console.

**(b) Setup.** Three Linux machines: local + two remotes; RemoteAgent CLI [verify]; pairing codes; Fleet Mission Control; panic stop bound.

**(c) Steps.**
1. Local: `omnia remote pair` [verify] → code/QR.
2. Remote-1 enters code; tile appears with health.
3. Pair remote-2; fleet shows 3/3 tiles, each with a lease indicator.
4. Task A ("collect logs") → remote-1 lease; remote-2 shows none.
5. Task B ("apply update") → remote-2, different TTL.
6. Lease matrix: machines x scope/TTL/status; no cross-machine scope.
7. Remote-1's Flight Recorder opens from console; entries local to it.
8. Panic Stop: all leases revoked fleet-wide; both remotes halt.
9. 4th pairing attempt rejected: "max 3" [verify copy].
10. Export fleet journals; per-machine hash chains.

**(d) Artifact.** 3-tile dashboard; lease matrix; per-machine journals; panic-stop log.

**(e) Pass metric.** Pairing <=60 s/machine [verify]; 3/3 tasks; panic <2 s; 0 cross-machine scopes; 4th rejected.

**(f) Contrast.** Cloud rivals cannot show this: remote control flows through their cloud, leases are account-wide, panic stop is server-side hope; Omnia revokes per machine on-device, each journaling locally.

### 4.7 Golden path — 90 seconds: Rehearsal → Healed Diff → Mission Control

| Time | Beat | On screen |
|---|---|---|
| 0:00–0:30 | Rehearsal | Skill Library → "Monthly Close" → Rehearse; risky overwrite pauses at Two-Key; deny it; report shows 0 writes. |
| 0:30–1:00 | Healed Diff | "Submit" was renamed; live run fails at step 7; diff proposes "Send expense" @0.94; approve; 11/11; healing receipt appears. |
| 1:00–1:30 | Mission Control | Remote-1 tile online; the healed skill runs there under a machine-scoped lease; remote-2 untouched; hit Panic Stop — both halt, journals export. |

**Close:** "Rehearsed. Healed. Fleet-safe." End card repeats: 0 bytes egress, every action under a lease, every machine journaled locally.

---

## 5. Cut / resequence trigger table (exact)

**Classification rule.** Failures split into two classes, and the critic is the classification authority (the builder does not self-classify):

- **Trust-class** = any leakage of secrets, keystrokes, clipboard, or foreign-app state into capture, drafts, journal, or any cross-process path. Hard stop: freeze the feature, fix, re-run the contract; no resequence debate while red.
- **Coverage-class** = capability failure without leakage (segmentation/anchor contract items fail, platform gaps, latency). Narrow scope to passing platforms; one time-boxed re-spike.

| ID | Trigger | Class / owner | Exact action | Exit condition |
|---|---|---|---|---|
| T1 | Redaction fixture leaks SECRETS/keystrokes/clipboard into capture drafts or journal | Trust / critic | Hard stop. M3 does not merge. Fix in place; no schedule or scope debate while red. | Fixture green; manual review of all drafts clean |
| T2 | A coverage fix touches and exposes the gate/emission path (leak becomes possible) | Trust / critic | Reclassify as T1. Hard stop. | Gate-path isolation proven by test |
| T3 | Week-1 capture contract fails items 1–3 on one platform (Linux contract passes) | Coverage / critic | Narrow to passing platform; one re-spike, time-boxed; continue M3a there | Contract items 1–6 green on >=1 platform |
| T4 | Two consecutive coverage failures across all platforms | Coverage / manager | Cut P3/P4 from v27. Resequence: Fleet #3 (10w), Copilot #4 (6w); Self-Healing + Packs to v27.1 | Decision review at second spike exit |
| T5 | M1 browser enforcement requires runtime plumbing | Scope / builder | Split M1 into 1a (gate + journal + leases over the 7 sites) and 1b (close browser + SCREEN_READ + UI_READ bypasses), run 1b parallel; do not slip M2 | Zero ungated dispatch test green |
| T6 | Latency red or missing per platform (default-deny) | Platform / researcher | Disable Copilot on that platform; Linux-first launch. Amber 150–400 ms ships off-by-default, labeled assistive | Harness p95 <150 ms per platform for enablement |
| T7 | Partial pass: M1–M3 acceptance green, M4–M5 red | Milestone / manager | Resequence: M3a "Teach Me Once" 6w → M3b "Anchor Replay" 6w; Copilot pulled ahead 6w; Self-Healing + Packs 8w; Fleet 10w | Milestone exit reviews |
| T8 | Fleet partial-failure test red | Safety / critic | Cap at 2 machines until fixed; no silent retries, ever | Remote state untouched and visibly red |
| T9 | Two-Key classification coverage gaps | Safety / critic | No autonomous release until covered; Two-Key is a milestone release gate | Classifier coverage + tests green |
| T10 | Rival ships offline replay **with** gate + vault integration | Market / researcher | Demote skills claim to "parity plus manifest-gated wedge"; keep build order; accelerate M3 | Quarterly re-verification |
| T11 | Rival ships offline replay **without** gate + vault | Market / researcher | Claim stands with the gate/vault distinction; no resequence | Quarterly re-verification |
| T12 | macOS packaged local vision nonviable or unmeasured | Platform / researcher | Copilot Linux-first only; skills cross-platform deferred; fund Metal path as a separate decision | Harness green per platform |

**Resequence consequences (exact):** T4 → Fleet promoted to #3 (10w), Copilot #4 (6w), Self-Healing + Packs to v27.1. T7 → M3a 6w, M3b 6w, Copilot pulled ahead 6w, Self-Healing + Packs 8w, Fleet 10w. T6/T12 → platform enablement only; no resequence. T10/T11 → claim wording only; build order unchanged.

---

## 6. Milestones and acceptance

| Milestone | Scope | Size | Exit criteria |
|---|---|---|---|
| **M1 Trust spine** | One `gate()` over the 7 sites, close 3 bypasses, instantiate AuditTrail + JSONL journal with rotation, leases (incl. computerId), Two-Key, panic stop | 6w | Single gate; zero ungated dispatch; lease expiry with UI killed; redaction fixture clean; Two-Key release gate |
| **M2 Rehearsal** | Plan objects, risk tags, batch approval, execute-time re-validation, shadow `simulate` mode | 8w | Zero driver input in simulate counter; stale approvals invalidate |
| **M3 Recorder + replay MVP** | Week 1: 5-day capture contract (critic). Then semantic-step capture, superskill draft, anchor replay on 3 apps, abort-after-two | 8w | 10-step task replayed; abort-after-two verified; contract items green |
| **M4 Self-healing + Packs v1** | Drift repair + Healed Diff; signed pack export/import | 6w | >=70% repair rate on drifted-UI matrix; manifest review blocks escalation |
| **M4.5 Latency harness** | SSE instrumentation, p50/p95 report, per-platform hardware matrix, green/amber/red decision record; runs parallel | 4–5d | Default-deny matrix published |
| **M5 Screen Copilot** | Hotkey ask/locate/spotlight; latency HUD | 6w | <150 ms p95 to enable; off by default otherwise; labeled assistive |
| **M6 Fleet beta** | 3 machines, per-machine leases, partial-failure UI, unpair-and-purge, token revocation | 10w | Cross-OS task completes or fails safely with full per-machine audit |

Total ~44 core weeks; M1–M2 sequence into M3; M4.5 runs parallel from M4. Platform coverage: Linux first-class; macOS AX and Windows UIA need packaged-app smoke tests in M1–M2; macOS local vision is default-deny until M4.5 measures it.

---

## 7. Repo grounding (verified 2026-09-27, branch `dev` @ `7c7292de41`)

This section records the actual state the v27 claims are built on, including deviations from OMNIA_CONTEXT.md. Uncommitted/untracked work exists (pairing, remote, overlay files), so M1 starts from a dirty tree — land the gate work on a clean branch.

**Gate (the central M1 fact).** 7 production `permissions.evaluate` call sites in 2 files: `server/computers.ts:862` (generic action gateway), `:1533` (credentials/SECRETS), `:1650` (command/PROCESS_EXECUTE), `:2597` (expectation/FILES_READ); `server/api.ts:809` (superskill call), `:1220` (input freeze/release UI_CONTROL), `:1257` (agent memory FILES_READ/WRITE). Three bypasses: browser actions short-circuit before the permission block (`computers.ts:853`; `executeBrowser` `:1999–2270` never evaluates `BROWSER`); `POST /v1/computer-use/analyze` (`api.ts:1019`) analyzes and captures with no evaluation (`computer-use/service.ts` calls `driver.observe()`/`screenshot` directly); `POST /v1/computers/:id/observe|find` (`api.ts:459`, `computers.observe` `:794`) are unguarded. Separately, OpenCode tool callers send `approve:true` + `approvedScopes` (e.g. `tool/computer/visual.ts:114–145`, `act.ts:249–298`, `browser.ts:160–163`), i.e. agent self-approval at the server boundary — remove this path in M1.

**Dead-but-designed assets to revive.** `security/approval.ts` — `ApprovalGrant` with `expiresAt`/`usesRemaining`/`persistent`/`fingerprint`, `isApprovalGrantValid`, `applyApprovalReply` (unused outside security + tests). `security/audit.ts` — `AuditTrail` class plus `auditPermissionDecision`/`auditApproval`/`auditRedaction`/`auditDangerousOperation` factories (never instantiated anywhere). A second, unwired policy engine also exists: `security/permissions.ts` (`evaluatePermission`, `assertPermission`) with no production imports — M1 decides keep-as-content or delete. Current grants are in-memory without TTL (`server/permissions.ts:138–147`).

**Journal attach points.** SSE `EventBus` (`server/events.ts`; `SERVER_EVENT_TYPES` includes `input.frozen/released`, `permission.*`, `computer_use.*`, `superskill.called`; 512-entry ring is the only rotation today; `GET /v1/events` supports Last-Event-ID replay). Desktop logging is electron-log at 5 MB/7-day rotation (`desktop/src/main/logging.ts`). A dev-only JSONL precedent exists at `opencode/src/cli/cmd/run/trace.ts`.

**Superskills.** JSON store `~/.local/share/omnia/superskills.json` (`superskills/registry.ts`), JSON-RPC 2.0 stdio/HTTP bridge (`superskills/bridge.ts`, 30 s timeout), call route gated (`api.ts:809`), create-with-AI flow (`app/src/components/settings-superskills.tsx:147–160` + i18n prompt).

**Pairing / remote.** 8-char single-use codes, `XXXX-XXXX`, TTL 10 min (`pairing/manager.ts`); `pair/claim` is unauthenticated by design (`server/server.ts:338`); remote paths use per-computer bearer tokens with a 90 s staleness reap but no TTL/revocation (`server/remote.ts`); long-poll `wait=25000` (clamped 0–50000); RemoteAgent CLI `remote/cli.ts` + `remote/agent.ts`.

**Overlay / input freeze.** Overlay window creation `desktop/src/main/omnia/overlay.ts` (transparent click-through always-on-top; "halo" is the context-doc name, code says agent overlay); driven by `agent-working.ts`; X11 grab + double-Escape with `INPUT_ESCAPE_WINDOW_MS = 700` (`daemon/input-grab-script.ts`); input events emitted at `computers.ts:556–571`.

**Vision.** `computer_visual` tool (`opencode/src/tool/computer/visual.ts`), analyze API (`api.ts:1019–1054`), service (`computer-use/service.ts`), catalog (`computer-use/models.ts`: UI-TARS 2B Q4_K_M default, Moondream 2 Q4_K, ShowUI entries), llama.cpp pinned `b11205`, CPU/Vulkan bundled, CUDA/ROCm downloadable; models `~/.omnia/models`, runtimes `~/.omnia/runtimes`.

**Doc conventions.** Root `docs/` did not exist; this brief establishes `docs/strategy/` following the SCOPE.md convention (plain Markdown, dated header, no YAML front matter). `specs/v27/` exists but is empty.

**Repo surprises that matter to v27.** (1) The gate is aspirational, as the manager's synthesis states. (2) Agent self-approval is the real hole under any "provable local control" claim — close before any marketing. (3) Lease machinery is already designed and dead; M1 is integration, not invention. (4) Remote tokens lack TTL/revocation — Fleet cannot ship without it.

---

## 8. Unknowns and watchlist

| # | Unknown | Owner | Resolution gate |
|---|---|---|---|
| 1 | Semantic step-segmentation schema across AT-SPI/AX/UIA | builder + critic | M3 week-1 capture contract (5 days), items 1–6 |
| 2 | macOS packaged local vision: no Vulkan; CPU path expected, Metal unconfirmed | researcher | M4.5 harness; default-deny until measured |
| 3 | Windows UIA canvas depth unverified | researcher | M1–M2 platform smoke tests |
| 4 | Rival evidence final pass (Rabbit Teach Mode 2026 status; Devin Outposts offline; Open Interpreter OS-mode maintenance) | researcher | Quarterly re-verification (T10/T11) |
| 5 | UI-TARS / Moondream redistribution terms before Skill Packs | researcher + critic | License review before M4 pack export |
| 6 | Prompt injection: screen/browser content is untrusted; gate bounds blast radius but does not classify intent | critic | P0 review item; watch (Claude for Chrome documents the same class) |
| 7 | LAN approver (P12) attack surface: TLS, expiry, rate limits required before any implementation | critic | Design review before scheduling |
| 8 | Journal retention policy and PII classification | critic + builder | M1 rotation + redaction fixtures |

---

## 9. Sources

Verified sources for §2 (IDs as cited). Every absence claim above is "none found" for the queries listed after the sources, not proof of non-existence.

1. https://openai.com/index/introducing-chatgpt-agent/ — Operator + deep research merged into ChatGPT agent; cloud browser + terminal.
2. https://openai.com/index/chatgpt-for-your-most-ambitious-work — Jul 9, 2026: desktop Computer Use on local apps/files; approvals; scheduled tasks.
3. https://learn.chatgpt.com/docs/computer-use — Computer Use macOS/Win; per-app approvals; Windows foreground-only; macOS locked use.
4. https://openai.com/index/introducing-workspace-agents-in-chatgpt/ — cloud workspace agents.
5. https://openai.com/index/chatgpt-agent-system-card/ — remote visual browser environment.
6. https://help.openai.com/en/articles/11487775 — app permission options; approval cards; "Important actions" default.
7. https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool — API toolset; sandbox; dedicated VM/container; developer-implemented confirmations.
8. https://github.com/anthropics/claude-quickstarts/blob/main/computer-use-demo/README.md — Docker/X11/VNC reference.
9. https://claude.com/product/cowork — screen takeover only when needed; per-app permission; research preview.
10. https://claude.com/download — mobile Remote Control to Claude Code CLI; Cowork/Code desktop.
11. https://claude.com/blog/claude-in-chrome-generally-available — Chrome GA; classifier auto-approve.
12. https://claude.com/claude-for-chrome — site permissions; "skip all permissions"; prompt-injection risk.
13. https://docs.claude.com/en/docs/claude-code/permissions — allow/ask/deny; sandbox.
14. https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview — Cowork cloud-default/local architecture.
15. https://docs.docker.com/ai/sandboxes/agents/claude-code.md — local model via Anthropic-compatible endpoint (experimental).
16. https://cursor.com/help/security-and-privacy/privacy.md — code sent to model providers; Privacy Mode; Self-Hosted Machines.
17. https://cursor.com/docs/enterprise/privacy-and-data-governance — Cloud Agents in isolated VMs; local agent mode.
18. https://developertoolkit.ai/en/cursor-ide/advanced-techniques/privacy-security — third-party: Cloud Agents auto-run; MCP per-invocation approval.
19. https://docs.devin.ai/work-with-devin/computer-use — own desktop environment; Outposts macOS uses existing session.
20. https://cognition.com/blog/introducing-devin-2-2 — desktop computer use, self-testing (Feb 2026).
21. https://cognition.com/blog/devin-is-getting-a-windows-pc — Devin in its own Windows VM (May 2026).
22. https://docs.devin.ai/work-with-devin/advanced-capabilities — parallel managed Devins; playbooks from sessions.
23. https://docs.devin.ai/release-notes/overview — Devin Outposts.
24. https://manus.im/docs/features/cloud-browser — cloud browser/VM; login; take-over.
25. https://manus.im/features/manus-browser-operator — local browser extension; explicit per-task authorization.
26. https://www.cnbc.com/2026/03/18/metas-manus-launches-desktop-app-to-bring-its-ai-agent-onto-personal-devices.html — Manus Desktop "My Computer"; Allow Once/Always Allow; Meta acquisition.
27. https://trust.manus.im/faq — local browser execution; no password storage; Wide Research.
28. https://www.rabbit.tech/blog/first-major-update-of-2026-dlam-openclaw-and-a-surprise — DLAM controls Windows/Mac, no VM.
29. https://www.rabbit.tech/support/article/dlam-byok — DLAM setup: Chrome/Chromium + BYOK + screen share.
30. https://www.rabbit.tech/newsroom/r1-lam-updates — r1 runs headless in cloud.
31. https://www.rabbit.tech/teachmode — Teach Mode records demonstrated web tasks; replays via r1.
32. https://www.rabbit.tech/updates — rabbitOS timeline: Teach Mode beta 2024; DLAM Jan 2026; 2.3 Jul 2026.
33. https://learn.microsoft.com/en-us/microsoft-copilot-studio/computer-use — configured Windows machine; allowlist; human supervision.
34. https://learn.microsoft.com/en-us/microsoft-copilot-studio/whats-new — computer use GA May 2026; Windows 365 for Agents MCP GA Jun 2026.
35. https://blogs.windows.com/windows-insider/2025/11/17/copilot-on-windows-copilot-actions-begins-rolling-out-to-windows-insiders/ — Copilot Actions in Agent Workspace.
36. https://blogs.windows.com/windowsexperience/2025/10/16/securing-ai-agents-on-windows — separate contained agent workspace.
37. https://copilot.microsoft.com/labs/experiments/copilot-actions — Copilot Actions experimental (Labs).
38. https://learn.microsoft.com/en-us/power-automate/desktop-flows/recording-flow — Power Automate Desktop recorder (adjacent).
39. https://learn.microsoft.com/en-us/power-automate/desktop-flows/run-unattended-desktop-flows — unattended local desktop flows (adjacent).
40. https://docs.openinterpreter.com/guides/running-locally — fully local; `interpreter.offline = True`; Ollama/LM Studio.
41. https://github.com/OpenInterpreter/open-interpreter — confirmation before code execution; auto_run bypass.
42. https://github.com/OpenInterpreter/open-interpreter/blob/main/docs/guides/os-mode.mdx — experimental OS mode mouse/keyboard.
43. https://www.openinterpreter.com/docs/terminal — current product: terminal agent; sandbox/approvals; skills.
44. https://changes.openinterpreter.com/log/local-iii — Local III experimental OS mode.
45. https://github.com/simular-ai/Agent-S — local GUI control; use-with-care; knowledge base learning.
46. https://www.usatoday.com/press-release/story/44303/simular-releases-sai-ushers-in-new-era-of-autonomous-computer-fleets/ — vendor press release: Sai assigns work to one or multiple computers.
47. https://github.com/X-PLUG/MobileAgent/tree/main/Mobile-Agent-v3 — ADB local control; local vLLM `--base_url`; Android/Harmony.
48. https://arxiv.org/html/2508.15144v1 — Mobile-Agent-v3 technical report.
49. https://github.com/X-PLUG/MobileAgent/blob/main/Mobile-Agent-E/README.md — self-evolving memory/Tips; Android only.
50. https://openadapt.ai/research + https://github.com/OpenAdaptAI/openadapt-flow — outside the 11: local deterministic record→replay of demonstrated GUI workflows.
51. https://arxiv.org/pdf/2604.01676 — outside the 11: Salesforce GPA single-demo GUI record-and-replay research.
52. https://arxiv.org/abs/2609.16635 — outside the 11: EchoPath execution-level replayable memory.
53. https://www.crn.com/news/ai/2026/ces-2026-lenovo-showcases-cross-device-ai-agent-copilot-pcs — outside the 11: Lenovo Qira cross-device agent.
54. https://www.turingpost.com/p/computer-use-ai-agents — outside the 11: UFO3 cross-device workflows.
55. https://arxiv.org/html/2608.05729v1 — research: one agent serving one user across heterogeneous devices.

**Absence-search protocol (queries run, summarized).** Offline teachable GUI record→replay: per-product queries for ChatGPT/Operator, Claude Cowork/Code/Chrome, Cursor, Devin, Manus, Rabbit Teach Mode, Copilot Actions, Open Interpreter OS mode, Agent S, Mobile-Agent, plus "AI agent record GUI workflow once replay offline local 2026" and "Power Automate Desktop recorder local replay offline RPA". Multi-device orchestration: "AI agent one session control multiple computers multi-device orchestration 2026" and "one AI agent session controlling several computers user-owned devices 2026", plus the per-product queries above. Results were "none found in the 11" for both; nearest adjacents are listed in §2.2.

---

*End of brief. Companion artifacts: builder M1 RFC (gate/leases/journal interfaces + failing-test list), researcher M4.5 latency-harness spec, critic week-1 capture contract + security checklist. Decision and triggers above are the strategist's synthesis of the room's manager decision; do not reopen the discussion — execute against §5 and §6.*
