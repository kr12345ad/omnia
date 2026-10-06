# Capture Contract — Week-1 Fixture Suite + Security Checklist

**Owner:** critic (classification authority per manager's decision — "adopt strategist's failure rule with critic as classifier").
**Gate:** M3 week-1 spike, Teach-by-Demonstration recorder. Decision lock Friday W1 18:00; adjudication closes Thu W2 12:00.
**Status:** specification complete. The recorder does not exist yet; every `packages/omnia/src/recorder/**` path below is PROPOSED.
No pass/fail may be claimed by anyone until a device-tier run exists with hashed artifacts.
**Appendices (full detail, normative):**
- `docs/security/capture-contract/part-a-fixtures.md` — fixture suite, schemas, harness, run commands.
- `docs/security/capture-contract/part-b-redaction-security.md` — verifier design, P0 gates, defect list.
- `docs/security/capture-contract/part-c-triggers.md` — taxonomy, authority, full trigger table, record template.

---

## 1. The six pass/fail items

| # | Item | Fixture | Tier | Metric | Pass bar |
|---|------|---------|------|--------|----------|
| 1 | Coverage | `linux.gnome.note-to-folder.v1`, 20 actions, GNOME Text Editor + Nautilus | CI + device | `coverage_ratio`, `typed_step_ratio`, step count, verb histogram | ratio == 1.0; typed >= 0.90; steps == 20 (device 18–22); zero unclassified |
| 2 | Cross-platform | same logical task `cross.type-click-save.v1` in 3 corpora | CI (+ one manual recording per platform) | schema key-set + schema digest equality across `linux-at-spi` / `macos-ax` / `windows-uia` via one `serializeStep()` | 3/3 identical, no platform branching |
| 3 | Redaction | `linux.redaction.vault-clipboard.v1` (vault + clipboard + sudo) | CI + device | zero sentinel bytes/variants/12-grams in draft, steps, journal; exclusion proven by ledger absence | zero leaks; SECRETS + CLIPBOARD_READ never subscribed |
| 4 | Replayability | `texteditor.replay10.v1`, `files.replay10.v1`, `settings.replay10.v1` | CI + device | semantic payload only (no coordinates, no elementId); `success` per app | >= 8/10 per app, 3/3 apps; 100% of successes `resolvedBy == "semantic-query"`; zero `target_ambiguous`/`target_not_found` |
| 5 | Stability | item-1 task captured twice under jitter J1/J2/J3 | CI + device | weighted edit distance on canonical steps / max(len) | <= 0.20 (20.1% fails) |
| 6 | Boundary | item-1 task replayed into a bare `EventBus` | CI | import-graph allowlist; runtime provenance trace; zero driver calls; zero `subscribeInputGrab` | all three; one untraced captured event fails |

**Shared semantic step:** `{verb, anchor{app,window,source,backend,role,name,path}, valueClass, risk, args{digest}}`; `anchor === null` only for global verbs (`launch_app`, `open_url`, `open_file`, `wait`, `run_command`, clipboard verbs, app-id activate/close). `valueClass == "unknown"` fails coverage; `risk` uses `DangerLevel`.

**Zero-unclassified contract:** the recorder owns a total `classify(event)` over all 48 `SERVER_EVENT_TYPES` (VERIFIED, `server/events.ts:1-50`); a static test fails whenever a new server event type is added without a classification. Credential mutations are `excluded`; `observation.created`, `permission.*`, `credential.used` are `context`, never steps.

**Fixtures are not gameable:** `coverage_ratio` alone can be gamed by classifying everything `ignore`; `typed_step_ratio` alone by emitting zero steps. The pair plus exact step count and verb histogram is the minimum honest measurement. Harness errors (zero events, zero steps) are failures, never passes.

**Harness:** `packages/omnia/src/recorder/{types,capture,classify,coalesce,anchors,schema,serializer,policy}.ts` + `contract/*.test.ts` + `device/run-contract.ts`; two tiers, both required — CI proves the measurement code with a fake driver, device satisfies the literal contract on real GNOME apps over public HTTP only.

```
bun --cwd packages/omnia test src/recorder/contract          # Tier CI, all six
bun --cwd packages/omnia run typecheck
DISPLAY=:0 bun run src/recorder/device/run-contract.ts --tasks item1,item4,item5 --require-apps ...  # Tier device
```
CI gate is green only when Tier CI exits 0, typecheck exits 0, and `artifacts/capture-contract/device-report.json` shows `items["1"].appsCovered >= 2`, `items["4"].passingApps == 3`, `item5.diff <= 0.20`.

**Predicted first failure: item 1, caused by item 6's enabling gaps.** `action.*` events carry no `actionId`; `observation.created` carries only `{observationId, elements: <count>}` — no tree on the bus; `OBSERVATION_TTL_MS = 350` (`daemon/linux.ts:42`, VERIFIED) makes captured element ids unusable later. Anchors therefore need the public observe API as a second source, and 20-actions-to-20-steps relies on a `(computerId, action, target)` coalescing heuristic until `actionId` exists. Expect item 1 to be the first red.

---

## 2. Redaction grep/hash checks + P0 security checklist

**Invariants:** I1 no secret byte in any encoding; I2 no 12+ char substring of a secret; I3 capture cannot subscribe to SECRETS/CLIPBOARD events; I4 `SECRETS` denied at the gate except explicit per-action approval; I5 no draft save before every P0 gate passes; I6 journal append-only, hash-chained, rotated, retention-bounded.

**Sentinels (generated per test process, 144+ bits, fixed prefix `OMNIA-CAPTURE-FIXTURE`):** vault secret, TOTP base32 seed, clipboard sentinel, sudo password containing `"` and `\`. Fixture file lives outside the artifact root, mode 0600, never committed.

**Four check families over draft + steps + journal + filenames:**
1. exact-byte grep for every sentinel;
2. SHA-256 window/digest comparison of the sentinel set vs. decoded artifact contents;
3. encoded-variant scan — base64, base64url, URL-encoding, JSON escaping, UTF-16LE/BE, case-folding, plus token prefixes (AKIA, sk-, ghp_, xoxb-, and the Part B expanded list);
4. 12-gram substring scan with a 4-gram prefilter.
Findings are safe by construction: `{artifact, check, offset, length, sha256_12, sentinel}` — never the matched bytes. Meta-tests must prove the verifier fires (a verifier that never fails proves nothing). Verifier interface: `recorder/redaction/verifier.ts`; standalone process `script/verify-capture-artifacts.ts`.

**Default exclusion, enforced twice:** gate-level — `SECRETS` is denied by default (VERIFIED, `server/permissions.ts:51`) and denied even under `fully_autonomous`; proposed `CAPTURE_SCOPES` allowlist is exactly `UI_READ, KEYBOARD, POINTER`, with `assertCaptureScope` throwing on SECRETS/CLIPBOARD_READ/CLIPBOARD_WRITE. Bus-level — a branded `CaptureEventSource` exposing only 5 event types (`action.started/completed/verified/failed`, `observation.created`); a tripwire test fails if capture ever adds `credential.*` or a clipboard event to the allowlist.

**P0 automated gates (A1–A12), each a command or assertion:** A1 zero-bytes scan; A2 `secretFindings(draft) == []`; A3 vault-echo digest gate; A4 deep redaction is a no-op on the draft; A5 bridge env values are `${env:NAME}` references, never literals; A6 every step provenance is `user/trusted`; A7 draft scopes exclude SECRETS/CLIPBOARD and are a subset of demonstrated actions; A8 sensitive `type` steps store `{{ref}}` only; A9 `parseSuperskill` passes; A10 save bound to one-use approval fingerprint; A11 Bearer/`-p`/password-shape scans; A12 journal HMAC-SHA-256 chain verifies.
**Manual (M1–M6, each with an evidence command):** human sign-off the draft matches what was demonstrated; read rendered instructions for contextual secrets; env references resolve to vault entries; screenshots default off with no frames on sensitive steps; consent banner + stop control wired; draft author is trusted identity.

**Journal controls:** NDJSON, one line per event, `redaction_hash` = HMAC-SHA-256 (never the existing 32-bit FNV fingerprint), `prev_hash` chain, 8 MiB rotation, 7-day retention.

---

## 3. Verified defect register (critic's independent checks)

Independently re-verified in the working tree against the claim list in Part B Appendix A:

| # | Defect | Evidence | Status |
|---|--------|----------|--------|
| V1 | Two different `redactSecrets` under one name; production path imports the weak one | `security/redaction.ts:207` (pattern/deep) vs `credentials/store.ts:100` (literal split/join); `server/computers.ts:25` imports from `../credentials`; used on stdout/stderr at `computers.ts:1750-1751` | VERIFIED |
| V2 | Vault-value redaction skips secrets shorter than 3 chars; exact case-sensitive split/join only | `credentials/store.ts:103-104` | VERIFIED |
| V3 | `contentFingerprint` is 32-bit FNV-1a, unsuitable as `redaction_hash` | `security/audit.ts:41-45` | VERIFIED |
| V4 | `AuditTrail` is defined but never instantiated anywhere | `security/audit.ts:213`; grep across `packages/omnia/src` finds only the definition | VERIFIED |
| V5 | `EventBus` stores and forwards raw payloads, no redaction/scope filter, 512-event history | `server/events.ts:86-104`, `SERVER_EVENT_LIMIT=512` at `events.ts:54` | VERIFIED |
| V6 | SSE sends `access-control-allow-origin: *` and replays raw payloads | `server/server.ts:238`, `api.ts:880-883` (note: lowercase header — case-sensitive greps miss it) | VERIFIED |
| V7 | Clipboard read returns raw text plus 4000-char preview | `server/computers.ts:1090-1103` | VERIFIED |
| V8 | `browser_type` echoes the typed value in message and metadata | `server/computers.ts:2245-2249` | VERIFIED |
| V9 | `credential.used` carries 200 chars of the raw command | `server/computers.ts:1776-1785` | VERIFIED |
| V10 | `CLIPBOARD_READ` and `SCREEN_READ` default to `"prompt"`, not excluded; `SECRETS` correctly denied | `server/permissions.ts:37-51` | VERIFIED |
| V11 | Observation TTL 350 ms makes captured element ids stale for replay | `daemon/linux.ts:42` | VERIFIED |

**Reported by Part B, not independently re-verified by the critic:** typed-text readback in verification evidence (`computers.ts:1956-1968`), element value/text unredacted (`computers.ts:1029-1031`), stdout/stderr scrub only on credential match, superskill plaintext persistence, plaintext vault `list()` returning secrets, redaction token-pattern gaps, protocol scope vocabulary missing `SECRETS`, private `stableValue` canonicalizer. Treat as likely-real until the M1 audit re-reads each line.

**Contradiction check:** none. One initial miss of mine (case-sensitive grep missing the lowercase CORS header) was resolved in V6's favor.

**Consequence:** the recorder build must not assume these are "later hardening." V5/V6/V7/V8/V9 are live leaks on today's bus and API; V1/V2 mean double-redaction is mandatory (rich + literal) until the two functions are unified. This is M1 work, and Part B's A-gates are the acceptance evidence.

---

## 4. Classification authority + M3a/M3b resequence trigger table

**Taxonomy:** items 2, 3 = trust-class (leak/divergence: hard stop). Items 1, 4, 5 = coverage-class (quality: narrow + ONE re-spike; two failures cut P3/P4). Item 6 = boundary-class (freeze + 24 business hours; escalates to trust if a secret-bearing surface was reached). Evidence states: PASS / FAIL / **UNVERIFIED** — UNVERIFIED is never PASS.

**Precedence:** trust (R3/R4) > boundary unresolved (R5→R3) > coverage (R2 > R1b > R1) > R0.

| Row | Outcome | Action | Milestone change | Sign-off | Re-entry |
|-----|---------|--------|------------------|----------|----------|
| **R0** | all six PASS | proceed full scope | M3a 6w → M3b 6w → Self-Healing+Packs 8w → Fleet 10w; Copilot base slot; Δ0 | manager + feature + security + architecture | n/a |
| **R1** | exactly one of 1/4/5 FAIL | narrow card + one re-spike Mon–Wed W2 | M3a +5bd (W3) or +3bd if re-spike green by Wed W2 18:00; downstream +1w | feature owner + manager | full scope returns when original artifact PASSes |
| **R1b** | 1–3 PASS, 4–5 FAIL, 6 PASS (partial pass) | no re-spike; split M3 | M3a 6w → M3b 6w (M3 total unchanged); **Copilot pulled ahead Δ−6w**, above Self-Healing+Packs and Fleet | manager + security ack + feature owner | none for M3; descoped re-widen under R1 |
| **R2** | any second coverage failure, or R1 re-spike FAIL | cut P3/P4 | M3 canceled; **Fleet #5→#3 (10w, W2–W11, Δ−20w); Copilot #4, W12**; capture flag default-off unchanged | manager + security ack + feature owner | new full 6-item spike PASS, next planning cycle; P4 after P3 with >=50-step >=90% anchor coverage |
| **R3** | item 3 FAIL | **trust-class hard stop**: M3 stopped; containment (flags off, draft quarantined, original deleted; rotate if a real secret) | M3 canceled; **Copilot #3, starts W2 (Δ<=−6w)**; skills behind Copilot | security owner (veto) + manager | new spike all six PASS incl. canary + ledger-absence |
| **R4** | item 2 FAIL | as R3 + serializer frozen at last known-good | as R3 | security owner + manager | as R3 + canonical-hash equality; cosmetic-only downgrade requires joint written finding, max one |
| **R5** | item 6 FAIL | boundary freeze; fix then re-test; no milestone change until re-test | green by Wed W2: +3bd; FAIL/unresolved Thu W2 12:00 ⇒ R3; secret-bearing surface reached ⇒ immediate R3 | architecture + security concur + manager | two consecutive green boundary proofs; CI gate for life of M3 |
| **R6** | any UNVERIFIED / ambiguous at lock | conservative default; never PASS | item 2/3 UNVERIFIED ⇒ R3-effective retroactive; 1/4/5 UNVERIFIED = coverage FAIL strike; 6 UNVERIFIED ⇒ R5 | manager + security | mapped row |

**Classifier rulings on the open ambiguities (exercise of assigned authority):**
1. The exact combination 4+5 red with 1–3 green is **R1b**, governing over the general two-strike R2 — that is the manager's adopted partial-pass rule.
2. **Boundary is confirmed as its own class**, freezing immediately and escalating to trust on any secret-bearing reach — a boundary failure is a security event, not a quality miss.
3. **UNVERIFIED counts as a coverage FAIL strike** for items 1/4/5 at lock. Missing evidence is never green; this prevents an all-green record from incomplete artifacts.
4. Re-spike compression authority (+3bd vs +5bd) and absolute start dates under R1b/R3/R4 are **manager-owned schedule decisions**, pinned in the Friday record; the classifier sets class only.
5. Class verdict precedes schedule action; a schedule signed first is invalid and reopens under R6. Trust wins all disputes; downgrade requires joint security+manager written finding, max one per spike.

**Decision record:** `docs/security/capture-contract/part-c-triggers.md` §4 (hashed artifacts, classes, row, deltas, sign-offs, containment, addenda). Friday 18:00 announcement is one line per row, e.g. "Split plan, M3a starts Monday W2; Copilot pulled ahead 6 weeks."

---

## 5. Open items / what remains uncertain

1. **macOS/Windows evidence is synthetic in CI.** Item 2's real-platform evidence needs one manual recording per OS; until then macOS/AX and Windows/UIA are UNVERIFIED on real hardware and R6 default applies. macOS has no Vulkan path — capture is CPU-only there and unmeasured.
2. **GNOME app availability:** fallback `gedit` for Text Editor; Nautilus and Settings assumed; device runner must fail loudly, not silently substitute.
3. **Coalescing heuristic (`actionId` absent)** is the known weakest link; if the spike shows >20% mis-grouped steps, item 1 fails and item 4 likely follows — predict R1b or R2.
4. **The recorder paths do not exist yet.** Everything under `src/recorder/**` is PROPOSED and must land with the tests; no task is "done" on a green CI tier alone.
5. **Manager to pin:** absolute dates for R1b/R3/R4 schedules; re-spike compression authority confirmation (ruling 4 above).

**Bottom line:** the suite is specified and independently spot-checked against the code; the security checklist is mandatory before any draft save; the trigger table gives exactly one path per Friday outcome. The verdict on the spike itself stays open until hashed device-tier artifacts exist — and two live leaks (V5/V6) plus the dual-redaction defect (V1) mean the recorder cannot be built safely without the M1 gate work this suite depends on.
