# Teach-by-Demonstration Capture Contract — Part A: Fixture Suite Specification

Status: executable fixture specification for the 5-day capture-contract spike that gates M3.
Audience: the developer who implements the harness and the recorder's capture layer.
Repo: `/home/krishnaa/omnia` (branch `dev`). Suite runs with `bun test` from `packages/omnia`.

Scope split:
- Part A (this document): fixture definitions for the six contract items, the capture step schema the
  fixtures measure against, exact metrics and thresholds, harness layout, manifest schema, run commands.
- Part B (different agent): redaction-verification internals. Part A only defines the call site and the
  prohibition assertions (see §6) against the interface `RedactionVerifier`.

A note on grounding: every `packages/omnia/...` path and every event/scope name used below was read from
the working tree at the time of writing and is marked VERIFIED. Anything that does not exist yet is
marked PROPOSED. Do not treat PROPOSED paths as facts.

---

## 0. Suite map

| # | Contract item | Fixture task(s) | Tier | Primary metric | Pass |
|---|---------------|-----------------|------|----------------|------|
| 1 | Coverage | `linux.gnome.note-to-folder.v1` (20 actions, 2 apps) | CI + device | `coverage_ratio == 1.0` and `typed_step_ratio >= 0.90` and step count == 20 | all three |
| 2 | Cross-platform | same logical task `cross.type-click-save.v1` in 3 corpora | CI | schema key-set equality + schema digest equality across `linux-at-spi` / `macos-ax` / `windows-uia` | 3/3 identical |
| 3 | Redaction | `linux.redaction.vault-clipboard.v1` | CI + device | zero secret bytes in serialized draft; SECRETS + CLIPBOARD_READ excluded by capture policy | zero leaks |
| 4 | Replayability | `texteditor.replay10.v1`, `files.replay10.v1`, `settings.replay10.v1` | CI + device | semantic (non-coordinate, non-elementId) payload, success >= 8/10 per app | 3/3 apps |
| 5 | Stability | `linux.gnome.note-to-folder.v1` captured twice under jitter J3 | CI + device | weighted edit distance / max(len) <= 0.20 | <= 0.20 |
| 6 | Boundary | `linux.gnome.note-to-folder.v1` replayed into a bare `EventBus` | CI | import-graph allowlist + zero driver calls during capture + zero `subscribeInputGrab` | all three |

Two tiers, both required by the 5-day gate:
- Tier CI (`bun test`, deterministic, no display): synthetic `ServerComputerDriver` (pattern:
  `createFakeDriver()` in `packages/omnia/src/server/server.test.ts:11`) plus recorded corpora.
- Tier device (`bun run src/recorder/device/run-contract.ts`, Linux X11 + AT-SPI): real GNOME apps driven
  by the scripted actor over the public HTTP API. The literal contract wording ("2 apps", "3 unchanged
  apps", "20-action scripted task") is satisfied only by Tier device; Tier CI proves the measurement code.

---

## 1. Ground truth: verified integration points

### 1.1 VERIFIED (read from the working tree)

| Module | What it is | Used by item |
|--------|------------|--------------|
| `packages/omnia/src/server/events.ts` | `SERVER_EVENT_TYPES` (48 types, lines 1-50), `ServerEvent {seq,type,at,serverId,computerId?,sessionId?,data?}`, `EventBus.emit/subscribe/since`, `SERVER_EVENT_LIMIT = 512` | 1, 2, 5, 6 |
| `packages/omnia/src/server/computers.ts` | `ComputerManager`; emits `observation.created` (:805, data `{observationId, elements: <count>, warnings}`), `action.requested` (:870, data `{action, requiredScopes}`), `permission.requested` (:876), `permission.decided` (:897), `action.started` (:1389, data `{action, target}`), `action.failed` (:1405/:1438/:1522), `action.verified` or `action.completed` (:1511, data `{action,target,verification,summary}`), `action.cancelled` (:700), `credential.used` (:1776, data `{credentialId, credentialName, command, viaSudoStdin}`); `executeBatch` (:2487); `ServerBatchStep` (:277, includes `expect`), `BatchStepResult {index,action,success,message,target,resolvedBy,confidence,verification,stateDelta,error}` (:281) | 1, 3, 4, 5 |
| `packages/omnia/src/server/api.ts` | `GET /v1/events` SSE (:880), `writeEvent` writes `event: <type>` / `id: <seq>` / `data: <json>` (:1284); `POST /v1/computers/:id/do` batch route (:534, supports `resumeFrom`); `POST /v1/computers/:id/observe` (:459); `POST /v1/computers/:id/find` (:468); credential CRUD emits `credential.created/updated/removed` (:623-639) | 1, 3, 4, 5, 6 |
| `packages/omnia/src/server/server.ts` | `startOmniaServer(options)`, options include `drivers`, `credentialsFile`, `superskillFile`, `approvalPolicy`, `now`; returns handle with `events`, `computers`, `permissions`, `credentials`; SSE `subscribe` sends `server.snapshot` first and replays `events.since(Last-Event-Id)` (:229-264) | all |
| `packages/omnia/src/server/permissions.ts` | `OMNIA_SCOPES` (15, lines 1-19), `DEFAULT_STATES` (:36-52): `SECRETS: "denied"`, `CLIPBOARD_READ: "prompt"`; `requiredScopesForAction()` (:189-267); `PermissionManager.evaluate` | 1, 3, 6 |
| `packages/omnia/src/security/redaction.ts` | `redactText` (:105), `redactSecrets` (:207), `secretFindings` (:228), `containsSecret` (:269), `REDACTED = "[REDACTED]"` | 3 |
| `packages/omnia/src/security/types.ts` | `DangerLevel = "none" \| "low" \| "medium" \| "high" \| "critical"` (:95-96) — reuse as the risk vocabulary | 1 |
| `packages/omnia/src/security/audit.ts` | `contentFingerprint` (:50), audit helpers; audit events are NOT on the server bus (separate `AuditTrail`) | 1, 5 |
| `packages/omnia/src/credentials/store.ts` | `ComputerCredential.secret`, `credentialEnv()` with `OMNIA_CREDENTIAL_*`, `redactSecrets(text, secrets)` (store-local), `defaultCredentialFile()` | 3 |
| `packages/omnia/src/superskills/types.ts` | `Superskill`, `SuperskillBridge {type:"stdio"|"http"}`, `SuperskillMethod {name,description,parameters,scopes}` — the drafting target for a captured task | 2, 3 (interface only) |
| `packages/omnia/src/environment/hierarchy.ts` | `fromProtocolObservation(input)` (:86) normalizes any driver's protocol `Observation` (AT-SPI/AX/UIA/browser) into one `SemanticObservation` | 2 |
| `packages/omnia/src/environment/model.ts` | `IndexedElement {index, depth, siblingIndex, path}` (:94-99) — basis for anchor paths | 1, 2, 4 |
| `packages/omnia/src/environment/serialize.ts` | `buildTaskContext` (:91), `serializeTaskContext` (:127), `TaskContext.version === 1` — the existing "one serializer"; the new step serializer must sit on the same normalization layer | 2 |
| `packages/omnia/src/daemon/host-driver.ts` | `HostDriver` interface (:46); `subscribeInputGrab` (:72); `createHostDriver` | 6 |
| `packages/omnia/src/daemon/linux.ts` | `LinuxHostDriver`, backend `"linux-at-spi"` (:443), `OBSERVATION_TTL_MS = 350` (:42) — element ids expire fast; `subscribeInputGrab` (:1155), `notifyGrab` (:1292) | 4, 6 |
| `packages/omnia/src/daemon/darwin.ts` | `DarwinHostDriver`, backend `"macos-ax"` (:482) | 2 |
| `packages/omnia/src/daemon/windows.ts` | `WindowsHostDriver`, backend `"windows-uia"` (:462) | 2 |
| `packages/omnia/src/daemon/input-grab-script.ts` | `INPUT_GRAB_SCRIPT` — raw X11 pointer/keyboard grab, exposes only `frozen`/`released`/`error`, no keystroke stream | 6 |
| `packages/desktop/src/main/omnia/server-host.ts` | `toServerDriver()` (:42) wires every `HostDriver` (including `subscribeInputGrab`, :72-74) into the server | 6 |
| `packages/omnia/src/computer-use/types.ts` | `SemanticElement {elementId, role, name, text, bounds, states, source}` (:32-40), `ComputerUseOperation` (:3) | 1, 2 |
| test conventions | tests colocated `*.test.ts`, `bun test` from `packages/omnia` (`packages/omnia/package.json`), `bunfig.toml` `[test] root = "./do-not-run-tests-from-root"` (do not run from repo root) | all |

### 1.2 VERIFIED absences (gaps this suite must expose, not paper over)

1. No recorder exists. `grep -ri "teach|demonstrat|recorder"` across `packages/omnia/src` finds nothing;
   the only "capture" hits are screenshots (`screenshot` action) and `capabilities`. The entire fixture
   suite below is greenfield.
2. `action.*` events carry no correlation id. There is no `actionId`; a single user action produces
   `action.requested` -> (`permission.decided`) -> `action.started` -> `action.verified|completed|failed`
   with only `(computerId, data.action, data.target)` to group them. The fixture asserts exact
   coalescing (20 actions -> 20 steps) to pin this heuristic down.
3. `observation.created` is metadata-only: `data = {observationId, elements: <count>, warnings}`.
   The element tree is never on the bus. Anchor construction therefore cannot be purely event-driven;
   the recorder needs a public, non-driver observation source. See §2.7 and gaps list.
4. No observation-by-id endpoint exists (only `POST /v1/computers/:id/observe`, which returns a fresh
   `Observation`). An anchor store keyed by `observationId` has no public retrieval path today.
5. Default permission states do not match the contract wording: `SECRETS` defaults to `denied` but
   `CLIPBOARD_READ` defaults to `prompt` (`permissions.ts:42`). "CLIPBOARD_READ excluded by default"
   must be enforced by the capture policy, not inherited from permission defaults.
6. No testdata/fixtures directory precedent in `packages/omnia`; corpus paths below are PROPOSED.

### 1.3 PROPOSED (SPECULATIVE — do not cite as existing)

- `packages/omnia/src/recorder/**` — the capture module and all contract tests (see §10).
- Event enrichment: `actionId` on all `action.*` events and `elementsDigest` (or full elements) on
  `observation.created`. If adopted, replace the coalescing heuristic in §2.7 with id joins.
- `RedactionVerifier` interface owned by Part B (§6).
- Manifest/corpus/testdata paths.
- Device runner CLI `src/recorder/device/run-contract.ts`.

---

## 2. Shared vocabulary the fixtures measure

### 2.1 Semantic step

Every captured action must serialize to exactly this shape. Field names are lowercase as in the contract.

```jsonc
{
  "verb": "click",                  // string; must be in VERBS (§2.2)
  "anchor": {                       // object, or null only for global verbs (§2.3)
    "app": "org.gnome.Nautilus",    // applicationId / window app from observation
    "window": "capture-demo",       // focused window title fragment at action time
    "source": "accessibility",      // "accessibility" | "dom" | "native" | "vision"
    "backend": "linux-at-spi",      // observation.backend, recorded verbatim (item 2)
    "role": "push button",
    "name": "New Folder",
    "path": [0, 3, 1],              // child-index path inside the window subtree
    "locator": { "path": [0, 3, 1] }// PROPOSED optional; mirror of path for replay
  },
  "valueClass": "none",             // one of VALUE_CLASSES (§2.4); "unknown" fails coverage
  "risk": "low",                    // one of DangerLevel (§2.5)
  "args": { "digest": "sha256:..." } // canonical, redacted args; never a secret/clipboard literal
}
```

`anchor === null` is allowed only for `launch_app`, `open_url`, `open_file`, `wait`, `run_command`,
`read_clipboard`, `write_clipboard`, and `activate_app`/`close_app` when the app is specified by id
rather than by an element. The harness asserts this predicate (`anchorRequired(verb)`).

### 2.2 Verb set

`verb` is the already-canonical action name used by the server catalog
(`packages/omnia/src/server/catalog.ts`, `OMNIA_ACTION_CATALOG`): `observe, read_text, read_value,
run_command, credentials, get_context, get_cursor, hover, mouse_down, mouse_up, middle_click, get_focus,
inspect, find, click, double_click, right_click, type, set_value, key, hotkey, focus, focus_window,
scroll, move, drag, copy, paste, launch_app, activate_app, close_app, open_file, open_url, screenshot,
wait, read_clipboard, write_clipboard, paste_table, dismiss, release_keys, browser_*, menu, do`.
The recorder must normalize aliases (`doubleclick` -> `double_click`, `keypress` -> `key`) using the same
alias table as `packages/omnia/src/actions/backend.ts:5-19`.

### 2.3 Anchor extraction (deterministic, platform-neutral)

Given the `Observation` that was current when the action fired (`observationId` from the enclosing
`observation.created`; see §2.7 for sourcing):

1. `window` = nearest ancestor with `role === "window"`; record its `name` as `window`.
2. `path` = child indices from the window root to the target element, computed from `parentId`
   (`r.children` lists) — the same information as `IndexedElement.path`
   (`packages/omnia/src/environment/model.ts:98`).
3. `name` = first non-empty of `accessibleName`, `name`, `label`, `text`, truncated to 120 chars.
4. `app` = `element.metadata.application` if present, else the focused window's app, else the manifest
   `app.id`.
5. `backend` = `observation.backend` verbatim. `source` = `"accessibility"` unless the element source
   says otherwise.
6. Anchor identity key for canonicalization: `app|window|role|name|path.join("/")`.

### 2.4 Value classes

`valueClass` is derived from verb + payload, in this order:

| Condition | valueClass |
|-----------|------------|
| `type` / `set_value`, payload scanned: `containsSecret(text)` true | `secret` |
| `type` / `set_value`, payload came from the clipboard in this capture (`paste`/`paste_table`) | `clipboard` |
| `type` / `set_value`, payload starts with `/`, `~`, or matches a file path | `path` |
| `type` / `set_value`, payload parses as a URL | `url` |
| `type` / `set_value`, otherwise | `literal` |
| `key` / `hotkey` / `press_keys` / `release_keys` | `key-combo` |
| `copy` / `paste` / `read_clipboard` / `write_clipboard` / `paste_table` | `clipboard` |
| `run_command` | `command` |
| `launch_app` / `activate_app` / `close_app` | `app-id` |
| `open_file` | `path` |
| `open_url` / `browser_navigate` / `browser_open` | `url` |
| `click` / `double_click` / `right_click` / `scroll` / `drag` / `move` / `hover` / `focus` / etc. | `none` |
| anything not matched by the table | `unknown` |

`args` must never contain a `secret` or `clipboard` literal. For those classes `args = {ref: "credential:<id>|clipboard:<hash>"}`.

### 2.5 Risk

`risk = max(riskOfScope(s) for s in requiredScopesForAction(verb))`, with the scope->DangerLevel map:

| Scopes | risk |
|--------|------|
| `UI_READ`, `SCREEN_READ`, or none | `none` |
| `UI_CONTROL`, `POINTER` | `low` |
| `KEYBOARD`, `BROWSER`, `NETWORK`, `CLIPBOARD_WRITE` | `medium` |
| `FILES_WRITE`, `PROCESS_EXECUTE` | `high` |
| `FILES_DELETE`, `SECRETS` | `critical` |

`requiredScopesForAction` is VERIFIED at `packages/omnia/src/server/permissions.ts:189-267`;
`DangerLevel` is VERIFIED at `packages/omnia/src/security/types.ts:95`. `run_command` with a matched
credential additionally carries `SECRETS` (`computers.ts:1649`), so its risk is `critical` even
though `requiredScopesForAction("run_command")` alone returns `["PROCESS_EXECUTE"]`.

### 2.6 Event classification table (the zero-unclassified contract)

The recorder owns a total function `classify(event): "step" | "context" | "ignore" | "excluded" | "unclassified"`.
"Zero unclassified" means: (a) every member of `SERVER_EVENT_TYPES` has exactly one class (static test),
and (b) no runtime event in the capture window returns `unclassified`.

| Class | Event types |
|-------|-------------|
| `step` | `action.requested`, `action.started`, `action.completed`, `action.verified`, `action.failed`, `action.cancelled`; `browser.action` only when `capture_policy.surfaces` includes `"browser"` |
| `context` | `observation.created`, `permission.requested`, `permission.decided`, `credential.used` |
| `excluded` | `credential.created`, `credential.updated`, `credential.removed` (vault mutations are never steps), and every `clipboard`/`SECRETS`-class action per `capture_policy.excluded_verbs` |
| `ignore` | all other 34 types (server.*, computer.*, input.*, session.attached, environment.changed, superskill.called, memory.*, browser.launched, browser.navigated, computer_use.*, auth.*) |

The static test is `expect(new Set(SERVER_EVENT_TYPES)).toEqual(new Set(Object.keys(EVENT_CLASSIFICATION)))`.
Adding a new server event type without classifying it fails this test. `SERVER_EVENT_TYPES` currently has
48 entries (VERIFIED, `events.ts:1-50`).

### 2.7 Capture window, correlation, and anchor sourcing

- Capture window: `[t0, t1]`; events are collected with `EventBus.subscribe` and backfilled with
  `EventBus.since(startSeq)` (`events.ts:106-115`). The window is bounded by the scripted actor's first
  and last HTTP call; in-process tests use the synchronous fake driver, so no sleeps are needed.
- Coalescing (until an `actionId` exists — PROPOSED): open a step on the first of
  `action.requested|action.started` for key `(computerId, data.action, data.target)`; attach
  `permission.*` and `credential.used` to the open step; close on
  `action.verified|action.completed|action.failed|action.cancelled` for the same key, or when the next
  step with the same key opens. `observation.created` attaches to the nearest open step.
- Anchor sourcing: the recorder takes a PROPOSED `ObservationProvider`
  `(computerId, observationId?) => Promise<Observation>` whose only allowed implementations are
  (a) `POST /v1/computers/:id/observe` or (b) an in-process call to `ComputerManager.observe` reached
  through the server's public API object (same thing, no driver import). The suite records which source
  produced each anchor (harness-side `anchorSource` metadata) and asserts it is `"server-api"`.
  This is the working around of gap 1.2-(3); an alternative PROPOSED fix is enriching
  `observation.created.data` with the element digest.

---

## 3. Fixture manifest and corpora

### 3.1 Manifest JSON Schema

One file per task under `testdata/manifest/`. Secrets are referenced by name only; values are generated
at test time (never committed).

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "CaptureContractFixture",
  "type": "object",
  "required": ["task_id", "app", "platform", "steps", "expected_verbs", "secret_fields"],
  "additionalProperties": false,
  "properties": {
    "task_id": { "type": "string", "pattern": "^[a-z0-9][a-z0-9.-]+$" },
    "description": { "type": "string" },
    "app": {
      "type": "object",
      "required": ["id", "name", "backend"],
      "properties": {
        "id": { "type": "string", "description": "applicationId, e.g. org.gnome.TextEditor" },
        "name": { "type": "string" },
        "backend": { "type": "string", "enum": ["linux-at-spi", "macos-ax", "windows-uia", "browser-cdp"] },
        "launch": { "type": "string", "description": "executable or launch_app argument" }
      }
    },
    "platform": { "type": "string", "enum": ["linux", "macos", "windows"] },
    "capture_policy": {
      "type": "object",
      "properties": {
        "excluded_verbs": { "type": "array", "items": { "type": "string" } },
        "excluded_scopes": { "type": "array", "items": { "type": "string" } },
        "surfaces": { "type": "array", "items": { "type": "string", "enum": ["desktop", "browser"] } }
      }
    },
    "secret_fields": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["kind", "ref"],
        "properties": {
          "kind": { "type": "string", "enum": ["credential", "clipboard", "typed"] },
          "ref": { "type": "string", "description": "credential name or runtime env var holding the value" },
          "field": { "type": "string", "enum": ["secret", "username", "value"] }
        }
      }
    },
    "steps": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["n", "verb", "anchor_required", "value_class"],
        "properties": {
          "n": { "type": "integer", "minimum": 1 },
          "verb": { "type": "string" },
          "anchor_required": { "type": "boolean" },
          "anchor_expect": {
            "type": "object",
            "properties": {
              "app": { "type": "string" },
              "window_contains": { "type": "string" },
              "role_in": { "type": "array", "items": { "type": "string" } },
              "name_contains": { "type": "string" }
            }
          },
          "value_class": { "type": "string" },
          "args": { "type": "object", "description": "literal args for the fixture actor; redacted at capture time" },
          "expect_events": { "type": "array", "items": { "type": "string" } }
        }
      }
    },
    "expected_verbs": {
      "type": "object",
      "description": "verb -> exact count for CI tier, +/-1 per verb allowed for device tier",
      "additionalProperties": { "type": "integer", "minimum": 0 }
    },
    "replay": {
      "type": "object",
      "properties": {
        "indices": { "type": "array", "items": { "type": "integer" } },
        "max_coordinates": { "type": "integer", "const": 0 },
        "required_success_ratio": { "type": "number", "default": 0.8 }
      }
    },
    "corpus": {
      "type": "object",
      "properties": {
        "observations": { "type": "string" },
        "events": { "type": "string" }
      }
    }
  }
}
```

### 3.2 Example manifest (item 1, Tier device)

`testdata/manifest/linux.gnome.note-to-folder.v1.json`:

```json
{
  "task_id": "linux.gnome.note-to-folder.v1",
  "description": "Type a note in Text Editor and save it into a new folder in Files.",
  "app": { "id": "org.gnome.TextEditor", "name": "GNOME Text Editor", "backend": "linux-at-spi", "launch": "gnome-text-editor" },
  "platform": "linux",
  "capture_policy": { "excluded_verbs": ["credentials", "read_clipboard", "paste"], "excluded_scopes": ["SECRETS", "CLIPBOARD_READ"], "surfaces": ["desktop"] },
  "secret_fields": [],
  "steps": [
    { "n": 1,  "verb": "launch_app",   "anchor_required": false, "value_class": "app-id", "args": { "app": "org.gnome.TextEditor" } },
    { "n": 2,  "verb": "type",         "anchor_required": true,  "value_class": "literal", "args": { "text": "Capture contract demo\n" } },
    { "n": 3,  "verb": "hotkey",       "anchor_required": false, "value_class": "key-combo", "args": { "keys": ["ctrl", "s"] } },
    { "n": 4,  "verb": "type",         "anchor_required": true,  "value_class": "path", "args": { "text": "capture-demo.txt", "window": "Save" } },
    { "n": 5,  "verb": "key",          "anchor_required": false, "value_class": "key-combo", "args": { "key": "Return" } },
    { "n": 6,  "verb": "type",         "anchor_required": true,  "value_class": "literal", "args": { "text": "Second line\n" } },
    { "n": 7,  "verb": "hotkey",       "anchor_required": false, "value_class": "key-combo", "args": { "keys": ["ctrl", "s"] } },
    { "n": 8,  "verb": "hotkey",       "anchor_required": false, "value_class": "key-combo", "args": { "keys": ["ctrl", "a"] } },
    { "n": 9,  "verb": "copy",         "anchor_required": false, "value_class": "clipboard", "args": {} },
    { "n": 10, "verb": "launch_app",   "anchor_required": false, "value_class": "app-id", "args": { "app": "org.gnome.Nautilus" } },
    { "n": 11, "verb": "hotkey",       "anchor_required": false, "value_class": "key-combo", "args": { "keys": ["ctrl", "l"] } },
    { "n": 12, "verb": "type",         "anchor_required": true,  "value_class": "path", "args": { "text": "~/Documents" } },
    { "n": 13, "verb": "key",          "anchor_required": false, "value_class": "key-combo", "args": { "key": "Return" } },
    { "n": 14, "verb": "click",        "anchor_required": true,  "value_class": "none", "anchor_expect": { "app": "org.gnome.Nautilus", "role_in": ["push button", "button"], "name_contains": "New Folder" } },
    { "n": 15, "verb": "type",         "anchor_required": true,  "value_class": "literal", "args": { "text": "capture-demo" } },
    { "n": 16, "verb": "key",          "anchor_required": false, "value_class": "key-combo", "args": { "key": "Return" } },
    { "n": 17, "verb": "activate_app", "anchor_required": false, "value_class": "app-id", "args": { "app": "org.gnome.TextEditor" } },
    { "n": 18, "verb": "hotkey",       "anchor_required": false, "value_class": "key-combo", "args": { "keys": ["ctrl", "a"] } },
    { "n": 19, "verb": "paste",        "anchor_required": true,  "value_class": "clipboard", "args": {} },
    { "n": 20, "verb": "hotkey",       "anchor_required": false, "value_class": "key-combo", "args": { "keys": ["ctrl", "s"] } }
  ],
  "expected_verbs": { "launch_app": 2, "type": 5, "hotkey": 6, "key": 3, "copy": 1, "click": 1, "activate_app": 1, "paste": 1 }
}
```

Count check: 2 + 5 + 6 + 3 + 1 + 1 + 1 + 1 = 20 actions, 2 apps
(`org.gnome.TextEditor` steps 1-9/17-20, `org.gnome.Nautilus` steps 10-16).

### 3.3 Corpus format (item 2)

`testdata/corpus/<platform>/<task_id>.json`:

```jsonc
{
  "task_id": "cross.type-click-save.v1",
  "platform": "linux",
  "backend": "linux-at-spi",
  "observations": [ { "observation": { "id": "...", "backend": "linux-at-spi", "elements": [ ... ] }, "target": { "kind": "application", "id": "..." } } ],
  "events": [ { "seq": 1, "type": "action.started", "at": 0, "computerId": "fixture", "data": { "action": "type", "target": "el-3" } } ]
}
```

Observations use the protocol `Observation`/`UIElement` shape (`packages/omnia/src/protocol/types.ts:293,687`),
exactly what `Daemon.LinuxHostDriver.observe()`, `DarwinHostDriver.observe()`, and
`WindowsHostDriver.observe()` return. The corpora are recorded once on each platform by running the
driver's `observe` and dumping JSON; on macOS/Windows they are shipped as data and replayed on Linux CI.

---

## 4. Item 1 — Coverage

### 4.1 Fixture

Task: `linux.gnome.note-to-folder.v1` (§3.2). Apps: GNOME Text Editor (`org.gnome.TextEditor`) and
GNOME Files / Nautilus (`org.gnome.Nautilus`). Both ship on a typical GNOME desktop and expose AT-SPI.
Fallbacks if absent on the device: `gedit` for the editor, and `org.gnome.Settings` is reserved for
item 4 so do not substitute it here. Tier CI uses the synthetic driver with the same manifest.

### 4.2 Scripted actor

`src/recorder/device/scripted-actor.ts` (PROPOSED) drives the manifest through the public HTTP API
(`POST /v1/computers/local/<action>` and `POST /v1/computers/local/do`), setting `approve: true` and a
fixed `sessionId`. It never calls a driver directly. On the CI tier the same actor code runs against
`startOmniaServer({ drivers: [fixtureDriver] })`; the fixture driver from `server.test.ts:11` is the
template (extend it to emit one `observation.created` + full `action.*` sequence per executed action).

### 4.3 Measurement

Let `E` be the multiset of events emitted in the capture window for `computerId` (all 48 types):

- `N_events = |E|`
- `N_unclassified = |{e in E : classify(e) == "unclassified"}|`
- `coverage_ratio = (N_events - N_unclassified) / N_events`  (1.0 when `N_events == 0` is a harness error, not a pass)
- Captured steps `S` after coalescing (§2.7).
- `is_typed(s) = s.verb in VERBS && (anchorRequired(s.verb) ? s.anchor != null && validAnchor(s.anchor) : true)
  && s.valueClass in VALUE_CLASSES && s.valueClass != "unknown" && s.risk in RISK_LEVELS`
- `typed_step_ratio = |{s in S : is_typed(s)}| / |S|` (1.0 when `|S| == 0` is a harness error)
- `step_count = |S|`; `verb_histogram = count(s.verb for s in S)`
- `anchor_match(s)`: `s.anchor.app == expected.app` and `s.anchor.window` contains
  `expected.anchor_expect.window_contains` and `s.anchor.role` in `role_in` and `s.anchor.name` contains
  `name_contains`, when `anchor_expect` is present.
- `anchor_hit_ratio = anchors matched / anchors expected`

### 4.4 Assertions and thresholds

| Assertion | Threshold |
|-----------|-----------|
| `coverage_ratio` | `== 1.0` |
| `typed_step_ratio` | `>= 0.90` |
| `step_count` | `== 20` (CI exact; device `18..22`) |
| CI: `verb_histogram == expected_verbs` | exact |
| device: `abs(verb_histogram[v] - expected_verbs[v]) <= 1` per verb, and total `18..22` | per verb |
| `anchor_hit_ratio` | `>= 0.80` on device; `== 1.0` on CI |
| every `observation.created` in the window has a resolvable `observationId` used by at least one anchor | hard fail |
| `EVENT_CLASSIFICATION` covers `new Set(SERVER_EVENT_TYPES)` exactly once each | hard fail (static) |

### 4.5 Failure signal

```
CONTRACT-FAIL item=1 task=linux.gnome.note-to-folder.v1 coverage=0.9583 typed=0.85 steps=24
  unclassified=[{"seq":41,"type":"environment.changed","data":{...}}]
  verb_diff={"hotkey":-2,"type":+1} extra_steps=[{"verb":"wait",...}]
  detail=...
CONTRACT-PASS item=1 ...
```

Exact template: `CONTRACT-FAIL item=<n> task=<id> coverage=<ratio> typed=<ratio> steps=<n> unclassified=<json> verb_diff=<json> detail=<json>`.

### 4.6 Why the asserts are written this way

`coverage_ratio` alone can be gamed by classifying everything `ignore`, and `typed_step_ratio` alone can
be gamed by emitting zero steps. The pair plus the exact step count and verb histogram is the minimum
set that cannot be satisfied without actually capturing the task.

---

## 5. Item 2 — Cross-platform

### 5.1 Fixture task

`cross.type-click-save.v1`: (1) launch the app, (2) `type` a literal into a named text field,
(3) `click` a named button, (4) `hotkey ctrl+s`, (5) `click` a named confirm control. Five steps is
enough to exercise `type`+`click`+`hotkey` anchors across the three accessibility backends.

### 5.2 Corpora

Three corpora recorded on real machines with the repo's own drivers (VERIFIED backends):
- Linux: `LinuxHostDriver` -> `"linux-at-spi"` (`daemon/linux.ts:443`)
- macOS: `DarwinHostDriver` -> `"macos-ax"` (`daemon/darwin.ts:482`)
- Windows: `WindowsHostDriver` -> `"windows-uia"` (`daemon/windows.ts:462`)

Each corpus follows §3.3. CI replays the three corpora through one recorder and one serializer.

### 5.3 Measurement and assertions

Serialize every step S through the single `serializeStep()` (PROPOSED, in `src/recorder/serializer.ts`),
which must call `EnvironmentRuntime.fromProtocolObservation` (`environment/hierarchy.ts:86`) and must not
branch on `platform`/`backend` (static check: no `switch`/`if` over `platform` or `backend` in the
serializer source, except assigning `anchor.backend`).

| Assertion | Threshold |
|-----------|-----------|
| Canonical key set of each serialized step equals the key set of the JSON Schema in §2.1 | identical across all 3 corpora |
| SHA-256 of the sorted key-set (schema digest) | one digest shared by all 3 corpora |
| Required fields present at every step (`verb`, `anchor` when required, `valueClass`, `risk`) | 100% per corpus (no `.min(0)` shortcuts) |
| `anchor.backend` equals the corpus backend and is recorded, not normalized away | 100% |
| Same 5 verbs and same anchor roles (after role normalization via `EnvironmentRuntime`/`normalizeRole`) for the equivalent steps | 5/5 |
| Serializer's output for the same logical step differs only in `anchor.backend`, `anchor.app/window/name` values | no structural diffs |

Platform-role vocabulary (GTK "push button" vs AX "AXButton" vs UIA "Button") is normalized by the
existing environment layer (`packages/omnia/src/environment/normalize.ts`, `normalizeRole`); the suite
asserts the *normalized* role, not the raw toolkit role. If `normalizeRole` does not yet collapse
`push button`/`AXButton`/`Button`, that is a defect the first CI run will print and the fix belongs in
`normalize.ts`, not in the serializer.

### 5.4 Failure signal

```
CONTRACT-FAIL item=2 task=cross.type-click-save.v1 corpus=macos-ax
  missing_keys=["anchor.locator.path"] extra_keys=[] digest=7c11 vs expected=1f90
  role_mismatch=[{"step":3,"expected":"button","observed":"AXButton"}]
CONTRACT-PASS item=2 ...
```

---

## 6. Item 3 — Redaction (Part B interface)

### 6.1 Fixture task

`linux.redaction.vault-clipboard.v1` (apps: GNOME Text Editor + one terminal app, e.g. `org.gnome.Console`):

| n | verb | detail |
|---|------|--------|
| 1 | `launch_app` | Text Editor |
| 2 | `write_clipboard` | value = clipboard nonce generated at test time |
| 3 | `paste` | into editor (CLIPBOARD_READ + UI_CONTROL) |
| 4 | `run_command` | `printf %s "$OMNIA_CREDENTIAL_PASSWORD" > "$TMPDIR/leak-probe.txt"` with `credential: "demo-vault"` (PROCESS_EXECUTE + SECRETS) |
| 5 | `read_clipboard` | returns the nonce (CLIPBOARD_READ) |
| 6 | `type` | the vault secret typed literally, as a user would when demonstrating a login |
| 7 | `hotkey` | `ctrl+a` |
| 8 | `copy` | copies the secret to the clipboard (CLIPBOARD_WRITE) |
| 9 | `close_app` | Text Editor, discard changes |

`secret_fields`:
`[{"kind":"credential","ref":"demo-vault","field":"secret"},
  {"kind":"clipboard","ref":"OMNIA_FIXTURE_CLIP_NONCE"},
  {"kind":"typed","ref":"OMNIA_FIXTURE_TYPED_SECRET"}]`.
Values are generated in-test (e.g. `crypto.randomUUID()` with a prefix), written only to a temp
`credentialsFile` passed to `startOmniaServer` (`OmniaServerOptions.credentialsFile`, VERIFIED), and to
process env for the fixture actor. Nothing secret is committed.

### 6.2 Assertions

| Assertion | Threshold |
|-----------|-----------|
| For every secret value V in `secret_fields`: `serializedDraft.indexOf(V) === -1` and `V` absent from every event payload stored by the harness | 0 occurrences |
| `Security.secretFindings(draft).length === 0` (`security/redaction.ts:228`) | 0 |
| `Security.containsSecret(draft) === false` | true |
| Steps 4/5/8 serialize with `valueClass in {"command","clipboard"}` and `args.ref` only; step 6 with `valueClass == "secret"` and `args.ref == "credential:demo-vault"` | exact |
| Capture policy default excludes `SECRETS` and `CLIPBOARD_READ`: `capture_policy.excluded_scopes` contains both, and no emitted step has `risk == "critical"` or `valueClass == "clipboard"` unless the manifest opts in | hard fail |
| `GET /v1/permissions` shows `SECRETS == "denied"` and `CLIPBOARD_READ == "prompt"` | informational (see gap 1.2-(5)); the suite does not rely on the permission state, only on the policy |
| Draft bytes are UTF-8 clean and JSON-parseable | hard fail |

### 6.3 Part B interface (referenced, not implemented here)

PROPOSED in `packages/omnia/src/recorder/redaction/verifier.ts` (owned by Part B):

```ts
export interface RedactionVerification {
  readonly pass: boolean
  readonly leaks: readonly { readonly ref: string; readonly path: string; readonly kind: "raw" | "hash-adjacent" }[]
  readonly checkedValues: number
}
export interface RedactionVerifier {
  verify(serializedDraft: string, secrets: readonly string[]): RedactionVerification
}
```

Part A's harness calls `verifier.verify(draft, values)` and asserts `pass === true`, in addition to the
raw byte assertions above (defense in depth: the raw scan catches leaks even if Part B regresses).

### 6.4 Failure signal

```
CONTRACT-FAIL item=3 task=linux.redaction.vault-clipboard.v1 secrets=3
  leaks=[{"ref":"demo-vault","path":"steps[3].args.stdout","kind":"raw"}]
  policy_excluded=["SECRETS","CLIPBOARD_READ"] observed_excluded=[]
CONTRACT-PASS item=3 ...
```

---

## 7. Item 4 — Replayability

### 7.1 Fixtures: three replay sets

Replay payloads are generated from captured steps. The payload contract is stricter than capture:
no coordinates and no element ids.

Each replay set is a 10-step prefix/subset of a captured task, expressed in the manifest under
`replay.indices`. Apps and their sets (all `linux-at-spi`):

| task_id | app | 10 steps (verbs) |
|---------|-----|------------------|
| `texteditor.replay10.v1` | `org.gnome.TextEditor` | launch_app, type, hotkey(save-as), type, key(Return), type, hotkey(save), hotkey(ctrl+a), copy, close_app |
| `files.replay10.v1` | `org.gnome.Nautilus` | launch_app, hotkey(ctrl+l), type(path), key(Return), click(New Folder), type(name), key(Return), click(sidebar Documents), hotkey(ctrl+w), close_app |
| `settings.replay10.v1` | `org.gnome.Settings` | launch_app, hotkey(ctrl+f), type(search "About"), click(About row), key(Escape), click(search field), type("System"), click(System row), key(Escape), close_app |

Settings steps are deliberately read-only navigation so the fixture cannot mutate the machine.

### 7.2 Replay channel

`POST /v1/computers/local/do` (VERIFIED, `api.ts:534`) with a `steps` array of `ServerBatchStep`s
(`computers.ts:277`). The actor builds each step as:

```jsonc
{ "action": "click", "query": "New Folder", "role": "push button",
  "window": "capture-demo", "approve": true, "sessionId": "replay-fixture" }
```

Forbidden in every step object (recursively): `x`, `y`, `from.x/from.y`, `to.x/to.y`,
`target.kind === "point"`, and `target.elementId`/`elementId`. Rationale (VERIFIED): element ids are
observation-scoped and `OBSERVATION_TTL_MS = 350` in `daemon/linux.ts:42`, so ids captured minutes ago
are stale; the server's semantic resolver (`resolveQuery`, `computers.ts:2330-2418`, sets
`resolvedBy: "semantic-query"`) is the only durable path. `type` steps pass `text` plus `window`;
`key`/`hotkey` steps pass `key`/`keys` plus `window`.

### 7.3 Assertions

| Assertion | Threshold |
|-----------|-----------|
| Recursive scan of the replay payload finds zero coordinate/elementId keys | 0 |
| `BatchResult.steps[i].success === true` count per app | `>= 8/10` |
| For each successful step, `BatchStepResult.resolvedBy === "semantic-query"` (VERIFIED field, `computers.ts:287`; populated from `metadata.resolvedBy`) | 100% of successes |
| Across the 3 apps: apps passing | `3/3` |
| No step fails with `error.code == "target_ambiguous"` or `"target_not_found"` | 0 (ambiguity means the anchor was not specific enough to replay) |

### 7.4 Failure signal

```
CONTRACT-FAIL item=4 app=org.gnome.Settings passed=7/10 coordinates=0 element_ids=0
  failed=[{"index":3,"action":"click","code":"target_not_found","query":"About"}]
  resolvedBy={"semantic-query":7,"undefined":0}
CONTRACT-PASS item=4 ...
```

---

## 8. Item 5 — Stability

### 8.1 Fixture

Capture `linux.gnome.note-to-folder.v1` twice in one harness run. On CI the synthetic driver applies a
deterministic jitter between run A and run B; on device the two runs are real and the jitter is whatever
the desktop produced. The CI jitter levels are part of the fixture so the metric is regression-tested:

| Level | Jitter | Expected diff |
|-------|--------|---------------|
| J1 | new observation ids, new `seq` numbers, new timestamps, new `sessionId` | 0.00 |
| J2 | J1 + window title suffix changes (" — Edited") and one anchor `name` changes case | <= 0.10 |
| J3 | J2 + one container's child order changes, shifting one `path` by one index | <= 0.20 |

Gate uses J3: `stability_diff(captureA_J3, captureB_J3) <= 0.20`.

### 8.2 Canonicalization

Before diffing, each capture is normalized:

1. Sort only within-step field objects (JSON key order fixed by construction, not sorting steps).
2. `canonicalStep(s) = "${s.verb}|${anchorKey(s.anchor)}|${s.valueClass}|${s.risk}|${argsDigest(s)}"`
   where `anchorKey` is §2.3-(6) and
   `argsDigest = s.valueClass in {"secret","clipboard"} ? "<redacted:" + s.valueClass + ">" : "sha256:" + hex(sha256(canonicalJson(s.args)))`.
3. Volatile fields (`at`, `seq`, `observationId`, `generatedAt`, `latencyMs`, element `bounds`) are dropped.

### 8.3 Exact metric

Weighted Levenshtein over two step arrays `A` (run A) and `B` (run B). Insert and delete cost 1.
Substitution cost:

- 0.5 when `verb`, `valueClass`, `risk` and `argsDigest` are equal and only `anchorKey` differs
  (anchor drift, the thing the contract cares about);
- 1.0 otherwise (verb/class/risk/args change).

```
D(i,j) = min(
  D(i-1,j) + 1,
  D(i,j-1) + 1,
  D(i-1,j-1) + sub(A[i], B[j])
)
stability_diff = D(|A|,|B|) / max(|A|,|B|)
```

Pass: `stability_diff <= 0.20` **and** `18 <= |A|,|B| <= 22` (a capture outside the width band is a
capture bug, not a good score). If one run is empty the metric is undefined; the harness must fail with
`capture_invalid`, never score 0.

### 8.4 Failure signal

```
CONTRACT-FAIL item=5 task=linux.gnome.note-to-folder.v1 diff=0.25 (5.0/20) threshold<=0.20
  substitutions=[{"a":4,"b":4,"cost":0.5,"reason":"anchor.path 3->4"},
                 {"a":11,"b":12,"cost":1.0,"reason":"type->key"}]
  lengths={"a":20,"b":21}
CONTRACT-PASS item=5 ... diff=0.00 (J1) / 0.05 (J2) / 0.15 (J3)
```

The harness prints all three jitter levels even when only J3 gates.

---

## 9. Item 6 — Boundary (event bus only, no driver hooks)

### 9.1 What "consume the event bus only" means, exactly

The recorder module (`packages/omnia/src/recorder/**`, excluding `device/` and `*.test.ts`) may:

- import `EventBus`/`ServerEvent` types from `../server/events` and read events via `subscribe`/`since`;
- import protocol/environment/security/redaction types for the step schema;
- call the server's public HTTP API for observations (`POST /v1/computers/:id/observe`) or the
  `ApiContext`-equivalent in-process call — no driver object may reach it.

The recorder may NOT import `../daemon/**`, `../server/computers.ts`, `computer-use/providers`, or any
`ComputerDriver`/`HostDriver` implementation; may NOT call `driver.observe/find/execute` or
`subscribeInputGrab`; may NOT register itself as `ComputerManager`'s `onObservation` callback (the
callback is a manager hook, not the bus — `computers.ts:496`).

### 9.2 Static assertion (import graph)

For each non-test source file under `src/recorder/`, use `Bun.Transpiler.scanImports` (or an equivalent
AST scan) and assert every import specifier matches:

```
^\./                                  (recorder-internal)
^\.\./(protocol|server/events|security|environment)(/|$)
^(node:|bun:)
```

and matches none of `/(daemon|host-driver|computers|providers|driver)/`. Failure prints the file and the
offending specifier.

### 9.3 Runtime assertion (sealed bus)

1. Build a bare `new EventBus({ serverId: "fixture", now })` (`events.ts:74`) with no server, no
   `ComputerManager`, no driver.
2. Replay the recorded event corpus for `linux.gnome.note-to-folder.v1` into it with `events.emit(type, payload)`
   in original `seq` order.
3. Run `CaptureSession` with the corpus observation provider (§2.7).
4. Assert the captured steps equal the steps the full-server tier produced for the same corpus
   (canonical JSON equality after §8.2).
5. Assert `subscribeInputGrab` was never referenced: in the full-server tier, wrap the fixture driver
   and count `subscribeInputGrab` calls while capture is active; require 0. The fixture server sets
   `driver.subscribeInputGrab` (present on `LinuxHostDriver`, VERIFIED `daemon/linux.ts:1155`) and the
   recorder must not touch it.
6. Assert capture never triggered a driver call that was not part of the scripted actor's own action:
   after the actor's last request returns, seal the fixture driver (every method throws); then flush
   any queued bus events and end the capture. Any throw fails with `driver_hook_after_seal`.

### 9.4 Pass/fail

| Assertion | Threshold |
|-----------|-----------|
| Import allowlist | 0 violations |
| Bare-bus steps == full-server steps | exact equality |
| `subscribeInputGrab` calls during capture | 0 |
| `driver_hook_after_seal` | 0 |

### 9.5 Failure signal

```
CONTRACT-FAIL item=6 violation=import file=src/recorder/capture.ts specifier=../daemon/linux
CONTRACT-FAIL item=6 violation=driver_hook_after_seal method=observe stack="..."
CONTRACT-PASS item=6 imports=0 inputGrab=0 sealed=0
```

---

## 10. Harness layout, manifest, and run commands

### 10.1 Proposed file tree (all PROPOSED — nothing here exists today)

```
packages/omnia/src/recorder/
  types.ts                         # CaptureStep, SemanticAnchor, ValueClass, RiskLevel, CaptureDraft
  capture.ts                       # CaptureSession: EventBus subscription -> steps (no driver imports)
  classify.ts                      # EVENT_CLASSIFICATION table + classify(event)
  coalesce.ts                      # step correlation rules (§2.7)
  anchors.ts                       # Observation -> SemanticAnchor (path from parentId)
  schema.ts                        # step JSON schema + validateStep()
  serializer.ts                    # serializeStep(): the one cross-platform serializer
  policy.ts                        # CapturePolicy defaults: SECRETS + CLIPBOARD_READ excluded
  redaction/verifier.ts            # Part B owns the body; Part A imports the interface
  contract/
    harness.ts                     # loadManifest, replayEvents, canonicalize, weightedEditDistance
    manifest.test.ts               # schema + classification-table coverage (static)
    coverage.test.ts               # item 1 (CI)
    cross-platform.test.ts         # item 2
    redaction.test.ts              # item 3 (calls Part B verifier)
    replay.test.ts                 # item 4 (CI)
    stability.test.ts              # item 5 (J1/J2/J3)
    boundary.test.ts               # item 6
  device/
    run-contract.ts                # Tier device runner: starts server with createHostDriver(new LinuxHostDriver()), scripted actor, real capture
    scripted-actor.ts              # manifest -> HTTP calls (shared by CI and device)
  testdata/                        # PROPOSED; no precedent in packages/omnia
    manifest/*.json
    corpus/linux/*.json
    corpus/macos/*.json
    corpus/windows/*.json
```

Naming follows the repo: colocated `*.test.ts`, `bun test`, no aliases, relative imports with `.js`
suffixes are used in `src` (`environment/model.ts:12`), so keep `./capture.js` style in the recorder.

### 10.2 Tier CI vs Tier device

- Tier CI runs `bun test` with `startOmniaServer({ drivers: [fixtureDriver], credentialsFile: <tmp> })`
  (option VERIFIED, `server/server.ts:48`) and never opens a window. Items 1-6 all have a CI
  implementation; items 4's real-app pass and item 1's real-app pass are device-only gates.
- Tier device needs: Linux, X11 (`DISPLAY=:0`; the Linux input path and input grab are X11-first,
  `daemon/linux.ts:441-472`), AT-SPI bus reachable, GNOME apps installed. It starts the same server with
  `Daemon.createHostDriver(new Daemon.LinuxHostDriver())` (exports VERIFIED in `daemon/index.ts`).

### 10.3 Exact run commands

From the repo root:

```bash
# CI tier, all six items (fast, deterministic)
bun --cwd packages/omnia test src/recorder/contract

# individual items
bun --cwd packages/omnia test src/recorder/contract/coverage.test.ts
bun --cwd packages/omnia test src/recorder/contract/cross-platform.test.ts
bun --cwd packages/omnia test src/recorder/contract/redaction.test.ts
bun --cwd packages/omnia test src/recorder/contract/replay.test.ts
bun --cwd packages/omnia test src/recorder/contract/stability.test.ts
bun --cwd packages/omnia test src/recorder/contract/boundary.test.ts

# typecheck
bun --cwd packages/omnia run typecheck

# Tier device (must run on the Linux desktop, not CI)
cd packages/omnia
OMNIA_CAPTURE_DEVICE=1 \
OMNIA_FIXTURE_CLIP_NONCE="$(openssl rand -hex 16)" \
OMNIA_FIXTURE_TYPED_SECRET="$(openssl rand -hex 16)" \
DISPLAY=:0 bun run src/recorder/device/run-contract.ts \
  --manifest testdata/manifest/linux.gnome.note-to-folder.v1.json \
  --tasks item1,item4,item5 --require-apps org.gnome.TextEditor,org.gnome.Nautilus,org.gnome.Settings
```

Do not run `bun test` from the repo root: `bunfig.toml` sets `[test] root = "./do-not-run-tests-from-root"`
and the root `test` script exits 1 on purpose.

### 10.4 CI gate

The M3 gate is green only when: Tier CI suite exits 0, `typecheck` exits 0, and the Tier device report
(`artifacts/capture-contract/device-report.json`, PROPOSED output path; `artifacts/` already exists at
the repo root) has `items["1"].appsCovered >= 2`, `items["4"].passingApps == 3`, and `item5.diff <= 0.20`.
The device runner writes the same `CONTRACT-FAIL/PASS` lines plus the JSON report.

---

## 11. Most likely to fail first

**Item 1 (Coverage) fails first, and its root cause is Item 6's enabling gap.** Concretely:

1. The bus is global. A capture window over a real desktop session sees `environment.changed`,
   `computer_use.*`, `memory.*`, `session.attached`, `permission.*` and more; "zero unclassified"
   forces an explicit 48-type classification table, and any event type added later breaks it until
   classified. The static coverage test will be the first red in the suite the moment someone adds a
   server event.
2. `action.*` events have no `actionId` (gap 1.2-(2)). Coalescing `action.requested -> action.started ->
   action.verified` plus interleaved `observation.created` into exactly 20 steps is a heuristic. One
   `settle()` observation emitted after a step, or a batched `do` action, and the step count drifts to
   21-24, failing `step_count == 20` and the verb histogram even though coverage and typing pass.
3. `observation.created` carries no elements (gap 1.2-(3)), so anchors need a second source. If that
   source is the driver (the tempting shortcut), Item 6 fails at the same time; if it is a fresh
   `POST /observe`, the observation is *after* the action and the anchor can name the wrong element
   (e.g. a dialog that already closed), which then shows up as `anchor_hit_ratio < 0.80` and later as
   replay failures. This is the central integration risk of the spike.

Item 5 is the second most likely (jitter J2/J3 crossing 0.20 when window titles include a modified
marker), and Item 2 third (toolkit role vocabulary not yet collapsed by `normalizeRole`, e.g. GTK
"push button" vs UIA "Button").

---

## 12. Defects, gaps, and unknowns

### 12.1 Product/plumbing gaps (verified against the tree)

1. No recorder, no step schema, no `risk`/`valueClass` vocabulary exists. `risk` today exists only on
   `DangerClassification` (`security/types.ts:101`). Everything in §2 is new.
2. `action.*` events have no correlation id; the suite pins a heuristic. Adding `actionId` to the emit
   sites in `server/computers.ts` (6 emit sites) is the single highest-value enabler.
3. `observation.created` is metadata-only; elements never reach the bus. Either enrich the event
   (`data.elements` or a digest) or accept a public-API observation fetch in the recorder. The suite
   currently allows the latter and asserts its provenance.
4. No observation-by-id endpoint. `POST /observe` returns a fresh observation; a strict bus-only
   recorder cannot reconstruct the exact pre-action tree. `OBSERVATION_TTL_MS = 350` makes cached
   element ids useless across steps anyway.
5. `CLIPBOARD_READ` defaults to `prompt`, not denied. The contract's "excluded by default" must be a
   capture-policy default (`policy.ts`), not a permission default. Amending `DEFAULT_STATES` would
   change unrelated behavior, so the spec deliberately does not.
6. `credential.used` includes `command.slice(0, 200)`. A fixture command that interpolates a secret
   into the shell string (instead of the `OMNIA_CREDENTIAL_*` env path) would leak the secret into the
   bus. The redaction fixture asserts the command never contains the secret; production `executeCommand`
   should redact `command` with the matched secret before emit (today it does not; VERIFIED emit at
   `computers.ts:1776-1786`).
7. `write_clipboard` returns no `length`/`hash` in the event payload, so a draft can only record a
   reference, not a fingerprint. `read_clipboard` result carries `hash` in the HTTP result but the
   `action.verified` event does not. If the draft wants clipboard content-class evidence, the bus needs
   `hash` on the event.
8. The bus has no backpressure or per-session partition: `SERVER_EVENT_LIMIT = 512` means a long
   demonstration plus heavy `computer_use.*` chatter can evict events before capture reads them if the
   recorder subscribes late. The harness starts capture before the actor; production must do the same,
   and this is worth an explicit note in the M3 plan.
9. Audit events are not on the bus (`security/audit.ts` is a separate `AuditTrail`), yet `secret.redacted`
   would be the natural receipt for item 3. Part B must decide whether to surface audit events on the bus
   or read the trail directly (the latter would violate Item 6's spirit if the trail lives in-process
   behind the driver boundary).

### 12.2 Unknowns requiring a human answer before implementation

1. Which app is "the text editor" on the target desktop: `gnome-text-editor` (default on GNOME 42+) or
   `gedit`? The manifests assume `org.gnome.TextEditor`.
2. Is the target session X11 or Wayland? AT-SPI works on both, but `subscribeInputGrab` and the input
   tests are X11-only (`daemon/input-grab-script.ts`). The device tier is specified for X11.
3. Who owns `packages/omnia/src/recorder/device/run-contract.ts` and where the device report is written
   (`artifacts/` exists at root, but no test writes there today).
4. Whether `browser.action` belongs in the default capture surface. The item 1 fixture uses desktop only,
   but the browser is where a lot of teach-by-demo sessions will happen; the classification table
   currently gates it behind `capture_policy.surfaces`.
5. The macOS/Windows corpora need one-time manual recording by someone with those machines; until then
   item 2 runs on synthetic corpora that mimic `macos-ax`/`windows-uia` payloads (the parsers exist:
   `parseDarwinObservation`, `parseWindowsObservation`), which is weaker evidence and must be labeled as
   such in the spike report.

### 12.3 Explicitly out of scope (Part B or later)

- Redaction-verification internals (hashing, entropy checks, timing side channels).
- Superskill drafting from the draft (the `Superskill` JSON shape is the interface; generation is a
  later milestone).
- Replay execution beyond the server's existing `do` batch path.
- UI for the recorder.
