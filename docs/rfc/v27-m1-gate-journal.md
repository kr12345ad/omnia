# M1 RFC — Trust Spine: `gate()` + Flight Recorder journal

Status: **FROZEN for implementation** · v27 · Owner: builder · 2026-09-27
Companion contract tests: `packages/omnia/src/server/m1-gate-contract.test.ts` (M1-CT-01/02 red today; M1-CT-03 green guard; M1-CT-04..10 todo).
Scope: M1 only. Leases ride this interface; rehearsal `simulate` is a field in the interface, enforced in M2.

---

## 0. Verified baseline (evidence, 2026-09-27)

| Fact | Evidence |
| --- | --- |
| Active policy engine is `PermissionManager` (15 scopes). Defaults: `UI_READ: granted`; `SECRETS: denied`; all others `prompt` (incl. `BROWSER`, `SCREEN_READ`). | `server/permissions.ts:1-17`, `:36-52`, `:105` |
| `evaluate(required, { sessionId, approval })` → `{ allowed, status, required, missing, reason }`. `sessionId` only reads an in-memory grants map that no production code populates. | `server/permissions.ts:138-147`, `:149-182` |
| `approve: true` with **no** `approvedScopes` waives every missing scope, including `denied` ones. Gate must never synthesize a blanket approval. | `server/permissions.ts:152-157` |
| Production `evaluate` sites: api.ts:809 (superskill), :1220 (input freeze/release), :1257 (memory); computers.ts:862 (generic action), :1533 (credentials), :1650 (run_command), :2597 (`expect.file`). | grep `.evaluate(` |
| `AuditTrail` exists and sanitizes (`safeText` 512 chars, `redactSecrets` metadata, `contentFingerprint`) but is **never instantiated**. No JSONL/journal code exists anywhere in `packages/omnia/src`. | `security/audit.ts:39`, `:50-52`, `:65`, `:68-70`, `:213-243` |
| Second engine `security/permissions.ts` (`PermissionRegistry.evaluate` :389, `evaluatePathAccess` path.ts:261) has **no production caller** — dormant. Out of M1. | grep consumers |
| EventBus `emit(type, {computerId?, sessionId?, data?})`; action/permission/input events at events.ts:17-26. | `server/events.ts:86-103` |
| User-data stores live in `~/.local/share/omnia/*.json`; `~/.omnia` is only models/runtimes. **Journal default is `~/.local/share/omnia/journal/` (corrects the earlier `~/.omnia/journal` note).** | credentials/store.ts:73-75; memory/store.ts:28-30; superskills/registry.ts:13-15; computer-use/service.ts:759-761; computer-use/local.ts:96-98 |

## 1. What M1 must deliver

1. One `gate()` drains every action path; zero ungated dispatch.
2. Three bypasses closed (browser, screen capture/analyze, `checkExpectation` observe).
3. `AuditTrail` instantiated; append-only JSONL journal persists every gate decision, with rotation and a zero-leak redaction fixture.
4. Lease integration hook frozen (`leaseId` carried on every decision); lease storage/enforcement lands in M1 as a thin follow-up **without interface change**.
5. `mode: "live" | "simulate"` carried and journaled now; simulate semantics are M2.

## 2. Frozen interfaces (new files)

### `packages/omnia/src/server/gate.ts`

```ts
import type { AuditTrail } from "../security/audit"
import type { EventBus } from "./events"
import type { JournalWriter } from "./journal"
import type { OmniaScope, PermissionDecision, PermissionManager } from "./permissions"

export type GateOrigin = "session" | "desktop" | "remote"
export type GateMode = "live" | "simulate"

export interface GateRequest {
  readonly action: string
  readonly scopes?: readonly OmniaScope[] // default: requiredScopesForAction(action)
  readonly sessionId?: string
  readonly computerId?: string
  readonly approval?: {
    readonly approved?: boolean
    readonly approvedBy?: string
    readonly scopes?: readonly OmniaScope[]
  }
  readonly leaseId?: string
  readonly origin?: GateOrigin // default: sessionId ? "session" : "desktop"
  readonly mode?: GateMode // default: "live"
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface GateDecision {
  readonly allowed: boolean
  readonly status: PermissionDecision["status"]
  readonly required: readonly OmniaScope[]
  readonly missing: readonly OmniaScope[]
  readonly reason?: string
}

export interface Gate {
  check(request: GateRequest): GateDecision
}

export function createGate(options: {
  permissions: PermissionManager
  journal?: JournalWriter
  trail?: AuditTrail
  events?: EventBus
  now?: () => number
}): Gate
```

Frozen semantics:
- `origin: "desktop"` (no `sessionId`) is allow-listed: the UI is the approver (`api.ts:1212-1214` states the same rule for input freeze). It still journals `origin: "desktop"`.
- `origin: "remote"` is reserved for the M6 fleet host; M1 records the value but treats it as `session`.
- `mode: "simulate"` journals `mode: "simulate"` and returns the real decision; it does **not** reach drivers (M2 enforces; interface fixed now).
- On every call the gate: (a) computes `required`, (b) calls `permissions.evaluate` unless `origin === "desktop"`, (c) records one `AuditEvent` via `createAuditEvent`/`auditPermissionDecision` (`security/audit.ts:75-102`) into `AuditTrail` and the journal, (d) returns `GateDecision`. Journal records the final decision, not intent.

### `packages/omnia/src/server/journal.ts`

```ts
import type { AuditEvent } from "../security/audit"
import type { GateMode, GateOrigin } from "./gate"

export interface JournalExtras {
  readonly leaseId?: string
  readonly origin: GateOrigin
  readonly mode: GateMode
}

export interface JournalWriter {
  append(event: AuditEvent, extras: JournalExtras): void
  readonly path: string
}

export function createJournalWriter(options?: {
  readonly file?: string // default join(homedir(), ".local", "share", "omnia", "journal", "events.jsonl")
  readonly maxBytes?: number // default 8 * 1024 * 1024
  readonly keep?: number // default 5
  readonly now?: () => number
}): JournalWriter
```

## 3. Call-site integration (all seven)

| # | Site | Current | After |
| --- | --- | --- | --- |
| 1 | `api.ts:809` superskill call | `context.permissions.evaluate(required, …)` | `context.gate.check({ action: "superskill.call", scopes: required, sessionId, approval, metadata: { superskill: id, method } })` |
| 2 | `api.ts:1220` input freeze/release | `evaluate(["UI_CONTROL"])` session-only | `context.gate.check({ action: "input.freeze" \| "input.release", scopes: ["UI_CONTROL"], sessionId, approval })` |
| 3 | `api.ts:1257` memory | `evaluate([scope])` session-only | `context.gate.check({ action: "memory.read" \| "memory.write", scopes: [scope], sessionId, approval })` |
| 4 | `computers.ts:862` generic action | `this.permissions.evaluate(required, …)` | `this.gate.check({ action: actionType, scopes: required, sessionId, approval, computerId: id })`; `action.requested` emitted from the gate outcome |
| 5 | `computers.ts:1533` credentials | `evaluate(["SECRETS"])` | `this.gate.check({ action: "credentials", scopes: required, …, computerId })` |
| 6 | `computers.ts:1650` run_command | `evaluate(PROCESS_EXECUTE [+SECRETS])` | `this.gate.check({ action: "run_command", scopes: required, …, metadata: { credentialId } })` |
| 7 | `computers.ts:2597` `expect.file` | `evaluate(["FILES_READ"])` | `this.gate.check({ action: "expect.file", scopes: ["FILES_READ"], …, computerId })` |

`ComputerManager` keeps `permissions` for `snapshot()` (`computers.ts:611`) and gains `gate: Gate` in `ComputerManagerOptions` (`computers.ts:490-498`). `ApiContext` (`api.ts:82-109`) gains `gate: Gate`.

## 4. Bypass closures

### B1 — Browser (required; currently no server-side evaluation)
`execute()` returns browser actions at `computers.ts:853-855` before the gate at `:860-903`; `executeBrowser` (`:1999-2271`) never calls `permissions.evaluate`. `requiredScopesForAction("browser_*")` already returns `["BROWSER"]` (`permissions.ts:190`).

Fix: move the two lines
```ts
if (actionType.startsWith("browser_")) {
  return this.executeBrowser(request, id)
}
```
from before the gate to immediately **after** the gate block (before `run_command` at `:905`). No other change.

**Verdict: not runtime-level.** `ServerActionRequest` already carries `approve`, `approvedBy`, `approvedScopes`, `sessionId` (`computers.ts:265-268`; parsed at `api.ts:264-267`); the engine browser tool already sends all four (`packages/opencode/src/tool/computer/browser.ts:160-163`). Raw calls without approval get 428; engine flow is unaffected. **No 1a/1b split.**

### B2 — Screen read (`computer_visual` analyze)
`/v1/computer-use/analyze` (`api.ts:1019-1054`) never evaluates; capture calls `driver.execute({ type: "screenshot" })` directly (`computer-use/service.ts:625-633`); `SCREEN_READ` is declared (`permissions.ts:2,37,76,212`) but evaluated nowhere.

Fix: add a route-level `screenReadPermission(context, body)` helper mirroring `inputControlPermission` (`api.ts:1215-1232`) with `["SCREEN_READ"]`, called before `context.computerUse.perform` (`api.ts:1041`); desktop-originated (no `sessionId`) stays allow-listed. Engine visual tool already sends `SCREEN_READ` in `approvedScopes` (`packages/opencode/src/tool/computer/visual.ts:135-144`). Service-level capture gating is defense-in-depth, not M1.

### B3 — `checkExpectation` observe
Window/text expectations call `computer.driver.observe()` (`computers.ts:2616`) with no scope; only `expect.file` is gated (`:2597`).

Fix: in `checkExpectation` (`:2585`), before the observe at `:2616`, `gate.check({ action: "expect.observe", scopes: ["UI_READ"], …approval })`; on denial return `{ met: false, message: "Verifying screen expectations needs UI_READ approval." }`.

## 5. Journal format

Default file: `~/.local/share/omnia/journal/events.jsonl` (override: `OmniaServerOptions.journalFile`). One JSON line per decision, `appendFileSync(..., { mode: 0o600 })`, `mkdirSync(dirname, { recursive: true })`. Schema v1 = the `AuditEvent` exactly as produced by `createAuditEvent` (already redacted), plus:

```json
{"id":"audit_…","timestamp":1758900000000,"type":"permission.evaluated","outcome":"allowed","status":"allowed","action":"click","resources":[],"reason":"…","actor":"session:abc","metadata":{…},"leaseId":null,"origin":"session","mode":"live","fingerprint":"a1b2c3d4"}
```

- `fingerprint` = `contentFingerprint(JSON.stringify(recordWithoutFingerprint))` (`security/audit.ts:50-52`) — integrity/scrubber anchor.
- Rotation: when `size >= maxBytes` rename `events.jsonl → events.1.jsonl`, shifting up, delete beyond `keep`. Defaults 8 MiB / 5 files.
- Redaction: inherited from `createAuditEvent` (`safeText` 512 chars on action/reason/resources, `redactSecrets` on metadata). Zero-leak fixture asserts no raw secret substring appears in any journal line.
- Write failure policy: default fail-open with a `journal.error` event and a `journal.writeFailures` health counter; `OMNIA_JOURNAL_STRICT=1` fails closed (denies the action). No `fsync` (matches existing stores; documented tradeoff).
- `AuditTrail` is instantiated per server and used as the in-memory view for the timeline scrubber. It is currently unbounded (`security/audit.ts:213-243`); M1 exposes a capped read view (last 2000) and carries a follow-up for a real bound.

## 6. Wiring (`packages/omnia/src/server/server.ts`)

After `const permissions = new PermissionManager(...)` (`server.ts:122`) and before `new ComputerManager` (`server.ts:132`):

```ts
const trail = new AuditTrail()
const journal = createJournalWriter({ file: options.journalFile })
const gate = createGate({ permissions, journal, trail, events })
```

- `OmniaServerOptions` gains `journalFile?: string` (pattern: `server.ts:44-65`).
- `ComputerManager` options gain `gate` (`server.ts:132-171` construction).
- `ApiContext` gains `gate` (`server.ts:266-331` construction, interface `api.ts:82-109`).
- Tests pass `journalFile: join(tempDir(), "journal.jsonl")`.

## 7. Failing-test list (freeze; M1 is done when all are green)

| ID | Where | Assertion | Today |
| --- | --- | --- | --- |
| M1-CT-01 | `m1-gate-contract.test.ts` | browser action + session, no approval → 428 `permission_required` | **FAIL (200; bypass)** |
| M1-CT-02 | same | analyze + session, no SCREEN_READ approval → 428 | **FAIL (200; bypass)** |
| M1-CT-03 | same | desktop-origin browser action → 200 (UI approver) | PASS (guard) |
| M1-CT-04 | gate unit test | spy journal: superskill/memory/freeze/action/credentials/run_command/expect.file each produce exactly one gate record | todo |
| M1-CT-05 | journal test | temp `journalFile`: JSONL line per decision; redaction fixture (secret-shaped metadata) leaves zero raw secret substrings | todo |
| M1-CT-06 | journal test | write > maxBytes → `events.1.jsonl` exists, oldest pruned | todo |
| M1-CT-07 | lease test | lease expires server-side with UI killed (lease commit) | todo |
| M1-CT-08 | rehearsal test | simulate mode emits zero driver input (driver counter delta = 0) | todo (M2) |
| M1-CT-09 | gate test | `expect.window` without UI_READ → `{ met: false }` | todo |
| M1-CT-10 | journal test | desktop call journals `origin: "desktop"` and does not consult `evaluate` | todo |

## 8. 1a/1b escalation verdict

**No split.** All three bypass closures are in-process edits in `computers.ts` / `api.ts`; the browser case is a five-line reorder and the required scope already exists. Escalate only if one of these proves true during implementation: (a) `BROWSER` must become per-action scopes, and the tool's single `approvedScopes` value cannot satisfy several (then add a scope-mapping table — still M1, not a split); (b) `BrowserController` must become out-of-process (it is in-process today: `computers.ts:90-122`, injected at `server.ts:159`).

## 9. Risks / open items

- **Pre-existing approval hole:** `permissions.ts:152-157` lets `approve: true` with no scopes waive even `denied` scopes. Gate never synthesizes blanket approval; journal records `approvedBy`; flag for a separate hardening RFC.
- **AuditTrail unbounded** — capped read view now, real bound follow-up.
- **Journal growth/durability** — rotation caps bytes; no fsync means a crash can lose the tail (accepted for M1).
- **Remote origin (M6)** — host journals before queueing; remote agent executes host-gated commands; `origin: "remote"` reserved.
- **Dormant `security/*` engine** — leave dormant in M1; revisit when recorder/replay needs path policy (M3).

## 10. Out of scope

Lease storage/UI (follow-up commit, same interface), Two-Key classification rules (separate note; reuses `DangerClassification` in `security/types.ts`), M2 simulate enforcement, M3 recorder capture.
