# Part B — Redaction Verification (grep/hash) + P0 Security Checklist

Teach-by-Demonstration recorder · week-1 capture-contract spike
Scope: security engineering specification only. No product/strategy decisions.

Targets under test (to be built):
- `packages/omnia/src/recorder/recorder.ts` (capture pipeline)
- `packages/omnia/src/recorder/scoped-events.ts` (event-bus facade)
- `packages/omnia/src/recorder/journal.ts` (append-only journal)
- `packages/omnia/src/recorder/redaction/verifier.ts` (owned here, interface Part A §6.3)
- spike harness `packages/omnia/src/recorder/redaction/harness.ts`

Existing code that MUST be reused, never reimplemented:
`security/redaction.ts`, `security/content.ts`, `security/audit.ts`, `security/provenance.ts`,
`security/approval.ts`, `credentials/store.ts`, `server/permissions.ts`, `server/events.ts`,
`superskills/registry.ts`, `protocol/guards.ts`.

---

## 0. Invariants and failure semantics

| # | Invariant | Enforced by test |
|---|-----------|------------------|
| I1 | No captured artifact contains a secret byte in any encoding | §1.5 (a)+(c), §1.6 meta |
| I2 | No captured artifact contains any 12+ char substring of a secret | §1.5 (b)+(d) |
| I3 | Capture cannot subscribe to SECRETS/CLIPBOARD events or scopes | §3.2, §3.3 |
| I4 | `SECRETS` is denied at the gate and only grantable by explicit per-action user approval | §3.1 |
| I5 | Draft cannot be saved before every P0 gate passes | §4.1 |
| I6 | Journal is append-only, keyed-hash chained, rotated, retention-bounded | §4.3 |

Failure semantics (normative):
- Any leak finding is a hard test failure and aborts the save. The session is marked
  `quarantined`; artifacts are not persisted beyond the temp dir; the temp dir is deleted.
- Verifier reports MUST NOT contain the matched bytes. Findings carry
  `{ artifact, check, offset, length, sha256_12, sentinel }` only (`sha256_12` is the first
  12 hex chars of the SHA-256 of the matched window, which is safe because the window is
  high-entropy; never log `content`).
- The verifier fixture file is `mode 0600` and lives OUTSIDE the artifact root so a recursive
  artifact scan can never include it.

---

## 1. Zero-secret-byte verification design

### 1.1 Sentinel fixtures (generated at test time)

File: `packages/omnia/src/recorder/redaction/sentinels.ts` (new, test-only).

```ts
import { randomBytes } from "node:crypto"

export const SENTINEL_PREFIX = "OMNIA-CAPTURE-FIXTURE"
export type SentinelLabel = "vault" | "totp" | "clipboard" | "sudo"

export interface CaptureSentinels {
  readonly vaultSecret: string
  readonly totpSeed: string
  readonly clipboard: string
  readonly sudoPassword: string
  readonly all: readonly string[]
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

export function base32(bytes: Uint8Array): string {
  let value = 0
  let bits = 0
  let out = ""
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

// Generated once per test process. The random suffix gives >=144 bits of entropy, so
// accidental occurrence in any real capture is impossible; the fixed prefix makes leaks
// greppable in CI logs and incident reports.
export function makeCaptureSentinels(): CaptureSentinels {
  const nonce = randomBytes(18).toString("base64url")
  const shape = `${SENTINEL_PREFIX}-${nonce}`
  const vaultSecret = `${shape}-VAULT`
  const clipboard = `${shape}-CLIPBOARD`
  // Contains `"` and `\` so JSON-escaping and URL-encoding variants differ from the exact string.
  const sudoPassword = `Omn!a-${randomBytes(12).toString("base64url")}-Sudo#9"\\`
  // Valid RFC 4648 base32, 32 chars = 160 bits — the shape a TOTP seed has.
  const totpSeed = base32(randomBytes(20)).slice(0, 32)
  return Object.freeze({
    vaultSecret,
    totpSeed,
    clipboard,
    sudoPassword,
    all: Object.freeze([vaultSecret, totpSeed, clipboard, sudoPassword]),
  })
}

export function sentinelEntries(sentinels: CaptureSentinels): readonly (readonly [SentinelLabel, string])[] {
  return [
    ["vault", sentinels.vaultSecret],
    ["totp", sentinels.totpSeed],
    ["clipboard", sentinels.clipboard],
    ["sudo", sentinels.sudoPassword],
  ] as const
}
```

Fixture materialization inside the test (never in the repo):
- `sentinels.json` written to `mkdtempSync(join(tmpdir(), "omnia-capture-fixtures-"))`, mode `0600`.
- The temp `CredentialStore` is created with that file and seeded with
  `save({ computerId: "local", name: "sudo", kind: "password", secret: sentinels.vaultSecret, rules: [{ kind: "command", match: "sudo" }] })`.
- The clipboard sentinel is written to the fake driver clipboard before the "user pastes" step.
- The sudo sentinel is delivered through the credential's stdin path.

Required spike drive sequence (produces the artifacts under test):
1. focus a fake password field, `type` the vault secret + Enter;
2. read the clipboard (clipboard sentinel) and paste it into a fake notes field;
3. run `sudo whoami` with the seeded credential (sudo password via stdin);
4. stop capture; write `steps/*.json`, `draft.superskill.json`, `journal.ndjson`.

### 1.2 Artifact surface (everything that must be scanned)

`listArtifacts(root)` recursively selects, by extension:
`.json`, `.ndjson`, `.jsonl`, `.log`, `.txt`, `.tmp`, `.md`, plus **filenames** (basename only).
Assertions:
- the artifact set contains at least `steps/*.json`, `draft.superskill.json`, `journal.ndjson`;
- `assert(artifactRoot)` is not an ancestor of the fixtures file
  (`!relative(artifactRoot, fixturesPath).startsWith("..")` is false ⇒ fixture outside);
- on-disk size budget: <= 64 files and <= 32 MiB total, else the check fails with
  `capture_artifact_budget_exceeded` (unbounded scans are themselves a risk).

### 1.3 Check families (normative definitions)

(a) **Exact-byte grep.** For every sentinel `s` and every artifact byte buffer `b`:
scan for `Buffer.from(s, "utf8")`, plus the raw UTF-16LE and UTF-16BE encodings of `s`
(`Buffer.from(s, "utf16le")` and byte-swapped). Offsets relative to the buffer.

(b) **SHA-256 hash comparison.** Build a digest index over all sentinel values *and*
their variants *and* every 12+ char window of each (see reduction in (d)):
`Map<sha256hex, SentinelLabel>`. Then:
- whole-file: `sha256Hex(decodedContent)` looked up in the index (a file that is exactly a
  secret or a single encoded variant);
- windowed: for each length `L` in `windowLengths = distinct(needle lengths) ∪ {12}`, slide
  over the decoded content; hash a window of length `L` only when its first 4 chars are in
  the 4-gram prefilter set `grams4`; look the digest up in the index.
This is the hash-based form of (d); it also catches full-file equality that a substring
scan catches anyway, and gives `sha256_12` for findings.

(c) **Encoded-variant scan.** Variants of each sentinel, scanned with exact byte search on
decoded text and raw bytes:

```ts
export function encodedVariants(value: string): readonly string[] {
  const bytes = Buffer.from(value, "utf8")
  const le = Buffer.from(value, "utf16le")
  const be = Buffer.from(le).swap16()
  const b64 = bytes.toString("base64")
  return [...new Set([
    value,
    value.toLowerCase(),
    value.toUpperCase(),
    b64,
    b64.replace(/=+$/, ""),
    bytes.toString("base64url"),
    encodeURIComponent(value),
    encodeURI(value),
    JSON.stringify(value).slice(1, -1),   // JSON-escaped, without quotes
    le.toString("latin1"),                // text-level view of UTF-16LE bytes
    be.toString("latin1"),                // text-level view of UTF-16BE bytes
  ])]
}
```
Plus an unconditional **token-prefix scan** (catches planted credentials even if a sentinel
was never used, and catches future leaks unrelated to the fixtures):
```ts
export const TOKEN_PREFIX_PATTERNS: readonly RegExp[] = [
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /(?:^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/g,
  /(?:^|[^A-Za-z0-9_-])gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /(?:^|[^A-Za-z0-9_-])xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /(?:^|[^A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}/g,
]
```
Any hit fails with `check: "token-prefix"` (no sentinel label).

(d) **Substring / n-gram (12+).** Reduction: *any* substring of length >= 12 of a needle
contains a 12-char substring of that needle. Therefore maintaining a `Set<string>` of all
12-grams of every needle+variant and testing each 12-char window of decoded content is
exact for "any 12+ char substring". Use the `grams4` prefix Set as a constant-time prefilter
(`grams4.has(window.slice(0, 4))`), then `grams12.has(window)`. Scan raw byte streams the
same way for UTF-16 via the latin1 text view of the raw bytes.

### 1.4 Reference module

File: `packages/omnia/src/recorder/redaction/verifier.ts` (new; Part A §6.3 names this file).

```ts
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import { encodedVariants, sentinelEntries, type CaptureSentinels, type SentinelLabel } from "./sentinels"

export type LeakCheck = "exact" | "digest-window" | "encoded-variant" | "ngram-12" | "token-prefix" | "filename"

export interface LeakFinding {
  readonly artifact: string
  readonly check: LeakCheck
  readonly offset: number
  readonly length: number
  readonly sha256_12: string
  readonly sentinel?: SentinelLabel
}

export class SecretLeakError extends Error {
  readonly code = "capture_secret_leak"
  constructor(readonly findings: readonly LeakFinding[]) {
    super(`capture artifacts contain ${findings.length} secret leak(s): ${findings
      .map((f) => `${f.artifact}:${f.offset}(${f.check})`).join(", ")}`)
    this.name = "SecretLeakError"
  }
}

const sha256Hex = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex")
const digest12 = (value: Uint8Array | string) => sha256Hex(value).slice(0, 12)

interface Needles {
  readonly exact: readonly { readonly value: Buffer; readonly text: string; readonly label: SentinelLabel }[]
  readonly grams4: ReadonlySet<string>
  readonly grams12: ReadonlySet<string>
  readonly digests: ReadonlyMap<string, SentinelLabel>
  readonly lengths: readonly number[]
}

export function makeNeedles(sentinels: CaptureSentinels): Needles {
  const exact: { value: Buffer; text: string; label: SentinelLabel }[] = []
  const grams4 = new Set<string>()
  const grams12 = new Set<string>()
  const digests = new Map<string, SentinelLabel>()
  const lengths = new Set<number>()

  for (const [label, value] of sentinelEntries(sentinels)) {
    for (const variant of encodedVariants(value)) {
      exact.push({ value: Buffer.from(variant, "utf8"), text: variant, label })
      exact.push({ value: Buffer.from(variant, "utf16le"), text: variant, label })
      exact.push({ value: Buffer.from(Buffer.from(variant, "utf16le")).swap16(), text: variant, label })
      lengths.add(variant.length)
      for (let i = 0; i + 12 <= variant.length; i += 1) {
        const gram = variant.slice(i, i + 12)
        grams12.add(gram)
        digests.set(sha256Hex(gram), label)
      }
      for (let i = 0; i + 4 <= variant.length; i += 1) grams4.add(variant.slice(i, i + 4))
      digests.set(sha256Hex(variant), label)
    }
  }
  return { exact, grams4, grams12, digests, lengths: [...lengths].sort((a, b) => a - b) }
}

const indexOfAll = (haystack: Buffer, needle: Buffer): number[] => {
  const hits: number[] = []
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return hits
    hits.push(at)
    from = at + 1
  }
}

export function scanBytes(bytes: Uint8Array, needles: Needles): LeakFinding[] {
  const findings: LeakFinding[] = []
  const buffer = Buffer.from(bytes)
  const raw = buffer.toString("latin1")
  const utf8 = buffer.toString("utf8")

  // (a) exact and (c) variants; exact needles include UTF-16LE/BE byte encodings.
  for (const needle of needles.exact) {
    for (const offset of indexOfAll(buffer, needle.value)) {
      findings.push({ artifact: "", check: "exact", offset, length: needle.value.length, sha256_12: digest12(needle.value), sentinel: needle.label })
    }
  }

  // (b)+(d) 12-gram scan with 4-gram prefilter, on both decoded views.
  for (const [view, check] of [[utf8, "ngram-12"], [raw, "ngram-12"]] as const) {
    for (let i = 0; i + 12 <= view.length; i += 1) {
      if (!needles.grams4.has(view.slice(i, i + 4))) continue
      const gram = view.slice(i, i + 12)
      if (!needles.grams12.has(gram)) continue
      const digest = sha256Hex(gram)
      findings.push({ artifact: "", check, offset: i, length: 12, sha256_12: digest.slice(0, 12), sentinel: needles.digests.get(digest) })
    }
  }

  // (b) whole-file digest and windowed digest by needle length.
  for (const length of needles.lengths) {
    for (let i = 0; i + length <= utf8.length; i += 1) {
      if (!needles.grams4.has(utf8.slice(i, i + 4))) continue
      const digest = sha256Hex(utf8.slice(i, i + length))
      const label = needles.digests.get(digest)
      if (label !== undefined) findings.push({ artifact: "", check: "digest-window", offset: i, length, sha256_12: digest.slice(0, 12), sentinel: label })
    }
  }

  // token shapes, always
  for (const pattern of TOKEN_PREFIX_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of utf8.matchAll(pattern)) {
      findings.push({ artifact: "", check: "token-prefix", offset: match.index ?? 0, length: match[0].length, sha256_12: digest12(match[0]) })
    }
  }
  return findings
}

export function artifactFiles(root: string): string[] { /* recursive walk, extension filter per §1.2 */ }

export function scanArtifacts(root: string, sentinels: CaptureSentinels): LeakFinding[] {
  const needles = makeNeedles(sentinels)
  const findings: LeakFinding[] = []
  for (const path of artifactFiles(root)) {
    const name = basename(path)
    for (const needle of needles.exact) {
      if (name.includes(needle.text)) {
        findings.push({ artifact: path, check: "filename", offset: 0, length: needle.text.length, sha256_12: digest12(needle.text), sentinel: needle.label })
      }
    }
    for (const finding of scanBytes(readFileSync(path), needles)) {
      findings.push({ ...finding, artifact: path })
    }
  }
  return findings
}

export function assertNoSecretBytes(root: string, sentinels: CaptureSentinels): void {
  const findings = scanArtifacts(root, sentinels)
  if (findings.length > 0) throw new SecretLeakError(findings)
}
```

### 1.4b Part A interface adapter

Part A §6.3 consumes exactly this shape; `verifier.ts` must export both the internal
functions above and this public adapter, so the Part A harness and this contract share one
implementation:

```ts
export interface RedactionVerification {
  readonly pass: boolean
  readonly leaks: readonly {
    readonly ref: string
    readonly path: string
    readonly kind: "raw" | "hash-adjacent"
  }[]
  readonly checkedValues: number
}

export interface RedactionVerifier {
  verify(serializedDraft: string, secrets: readonly string[]): RedactionVerification
}

export function createRedactionVerifier(sentinels: CaptureSentinels): RedactionVerifier {
  return {
    verify(serializedDraft, secrets) {
      const findings = scanBytes(Buffer.from(serializedDraft, "utf8"), makeNeedles(sentinels))
      const pointer = locateJsonPointers(serializedDraft, sentinels) // deepest string field containing a needle
      return {
        pass: findings.length === 0,
        leaks: findings.map((f) => ({
          ref: f.sentinel ?? "token-shape",
          path: pointer.get(f.offset) ?? `@byte:${f.offset}`,
          kind: f.check === "digest-window" || f.check === "ngram-12" ? "hash-adjacent" : "raw",
        })),
        checkedValues: secrets.length,
      }
    },
  }
}
```
`locateJsonPointers` walks the parsed draft and records, for each JSON pointer, the byte
offsets of strings that contain a needle; the report never includes the string itself.
Test: feed the Part A failure example and assert
`{ pass:false, leaks:[{ref:"demo-vault", path:"steps[3].args.stdout", kind:"raw"}] }` shape
without any secret material in `JSON.stringify(result)`.

### 1.4c Sentinel naming alignment with Part A §6.1

| Part A ref | Part B fixture field | Notes |
|---|---|---|
| `credential:demo-vault` | `vaultSecret` | seeded into the temp `CredentialStore` with `rules:[{kind:"command",match:"sudo"}]` |
| `OMNIA_FIXTURE_CLIP_NONCE` | `clipboard` | written to the fake clipboard before step 5 |
| `OMNIA_FIXTURE_TYPED_SECRET` | `vaultSecret` typed literally at step 6 | same value as the vault secret, so one sentinel covers both shapes |
| `sudo` password shape | `sudoPassword` | delivered via credential stdin; `"`/`\` force distinct JSON/URL variants |
| TOTP seed | `totpSeed` | valid base32; no existing redaction pattern matches it (finding 2.2-5) |

Artifact paths scanned are Part A's: `capture/steps/*.json`, `capture/draft.superskill.json`,
`capture/journal.ndjson` (plus temp files and filenames, §1.2).

### 1.5 bun test assertions (CI)

File: `packages/omnia/src/recorder/redaction/capture-contract.test.ts`.

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeCaptureSentinels, sentinelEntries } from "./sentinels"
import { artifactFiles, assertNoSecretBytes, scanArtifacts, SecretLeakError } from "./verifier"
import { runRecorderSpike } from "./harness"

describe("zero-secret-byte capture contract", () => {
  const sentinels = makeCaptureSentinels()
  let artifacts = ""
  let fixtures = ""

  beforeAll(async () => {
    artifacts = mkdtempSync(join(tmpdir(), "omnia-capture-artifacts-"))
    fixtures = mkdtempSync(join(tmpdir(), "omnia-capture-fixtures-"))
    writeFileSync(join(fixtures, "sentinels.json"), JSON.stringify(sentinels), { mode: 0o600 })
    await runRecorderSpike({ artifactsDir: artifacts, sentinels })
  })
  afterAll(() => {
    rmSync(artifacts, { recursive: true, force: true })
    rmSync(fixtures, { recursive: true, force: true })
  })

  test("capture produced the three artifact classes and the fixture is outside the root", () => {
    const files = artifactFiles(artifacts)
    expect(files.some((f) => f.includes("steps/") && f.endsWith(".json"))).toBe(true)
    expect(files.some((f) => f.endsWith("draft.superskill.json"))).toBe(true)
    expect(files.some((f) => f.endsWith("journal.ndjson"))).toBe(true)
    expect(artifacts.startsWith(fixtures)).toBe(false)
    expect(join(fixtures, "sentinels.json").startsWith(artifacts + "/")).toBe(false)
  })

  test("(a)+(b)+(c)+(d): every artifact is free of sentinel bytes, variants, digests, and 12-grams", () => {
    const findings = scanArtifacts(artifacts, sentinels)
    expect(findings).toEqual([])          // failure message prints offsets/digests only
    expect(() => assertNoSecretBytes(artifacts, sentinels)).not.toThrow()
  })

  test("token-prefix shapes are never present", () => {
    const findings = scanArtifacts(artifacts, { ...sentinels, all: [] })
    expect(findings.filter((f) => f.check === "token-prefix")).toEqual([])
  })

  test("external grep process agrees and never echoes secret material", async () => {
    const proc = Bun.spawnSync([
      "bun", "run", "script/verify-capture-artifacts.ts",
      "--artifacts", artifacts, "--fixtures", join(fixtures, "sentinels.json"),
    ], { cwd: join(import.meta.dir, "../../../../..") })
    expect(proc.exitCode).toBe(0)
    const output = proc.stdout.toString() + proc.stderr.toString()
    for (const [, value] of sentinelEntries(sentinels)) {
      expect(output).not.toContain(value)
      expect(output).not.toContain(Buffer.from(value, "utf8").toString("base64"))
      expect(output).not.toContain(encodeURIComponent(value))
    }
  })
})
```

CI commands (from repo root):
```bash
bun --cwd packages/omnia test src/security/capture-contract/   # spike contract
bun --cwd packages/omnia test                                  # package regression
bun run lint
bun run typecheck
```
`bun run test` at the repo root intentionally exits 1; never use it.

### 1.6 Verifier meta-tests (a verifier that never fires proves nothing)

File: `packages/omnia/src/recorder/redaction/verifier.test.ts`.

```ts
const sentinels = makeCaptureSentinels()
const expectFinding = (bytes: Uint8Array | string, check: string) => {
  const findings = scanBytes(typeof bytes === "string" ? Buffer.from(bytes) : bytes, makeNeedles(sentinels))
  expect(findings.some((f) => f.check === check)).toBe(true)
}

test("detects exact sentinel", () => expectFinding(sentinels.vaultSecret, "exact"))
test("detects base64", () => expectFinding(Buffer.from(sentinels.vaultSecret).toString("base64"), "exact"))
test("detects base64url without padding", () => expectFinding(Buffer.from(sentinels.vaultSecret).toString("base64url"), "exact"))
test("detects URL-encoding", () => expectFinding(encodeURIComponent(sentinels.sudoPassword), "encoded-variant"))
test("detects JSON-escaped", () => expectFinding(JSON.stringify(sentinels.vaultSecret).slice(1, -1), "exact"))
test("detects UTF-16LE bytes", () => expectFinding(Buffer.from(sentinels.vaultSecret, "utf16le"), "exact"))
test("detects UTF-16BE bytes", () => expectFinding(Buffer.from(Buffer.from(sentinels.vaultSecret, "utf16le")).swap16(), "exact"))
test("detects lowercase variant", () => expectFinding(sentinels.totpSeed.toLowerCase(), "exact"))
test("detects 12-char substring", () => expectFinding(sentinels.vaultSecret.slice(7, 19), "ngram-12"))
test("detects token prefix shape", () => expectFinding("AKIA" + "A".repeat(16), "token-prefix"))
test("detects filename leak", () => { /* create file named sentinels.vaultSecret + ".json" */ })
test("clean artifact produces zero findings", () => expect(scanBytes(Buffer.from('{"action":"click"}'), makeNeedles(sentinels))).toEqual([]))
```

Perf budget assertion: scan of a 32 MiB synthetic artifact with 4 sentinels completes in
`< 5000 ms` (`test("scan stays within budget")`), so CI cannot silently degrade to O(n·m).

---

## 2. Reuse map and real gaps

### 2.1 Exact exports the recorder must reuse

| Need | Reuse | Location |
|---|---|---|
| Pattern-based deep redaction of any object before it becomes an artifact | `redactSecrets(value, { keys, replacement })`, `redactText`, `redactObject`, `redactHeaders`, `redactUrl`, `redactError`, `makeRedactor` | `packages/omnia/src/security/redaction.ts:105-293` |
| Finding secrets that must abort capture | `secretFindings`, `containsSecret` | `security/redaction.ts:228-271` |
| Vault-value exact replacement (vault secret in stdout/stdin/UI text) | `redactSecrets(text, secrets)` (literal), `summarizeCredential`, `CredentialStore.summaries()` — never `list()` in capture code | `credentials/store.ts:85-107, 202-214` |
| Redaction of every string at envelope construction | `contentEnvelope`, `userInstruction`, `untrustedContent`, `assertPromptSafe`, `renderEnvelope` | `security/content.ts:50-124, 176-189, 250-264` |
| Trusted/untrusted provenance (a demonstrated step is a user action; model-generated prose is data) | `makeProvenance`, `untrustedProvenance`, `isTrustedProvenance`, `assertUserInstruction` | `security/provenance.ts:67-121, 163-167` |
| Immutable, redacted audit events | `createAuditEvent` (does `deepFreeze(redactSecrets(metadata))`, `safeText` truncation) | `security/audit.ts:39-70` |
| Approving capture and draft save | `makeApprovalGrant`, `isApprovalGrantValid`, `evaluateApproval`, `ApprovalRegistry` | `security/approval.ts:85-262` |
| Gate for SECRETS/CLIPBOARD at the permission layer | `PermissionManager.evaluate`, `requiredScopesForAction`, `OMNIA_SCOPES` | `server/permissions.ts:105-187, 189-272` |
| Detection of credential-context steps | `classifyDanger` (`patterns.credential`, `paths.secret`) | `security/dangerous.ts:65-163` |
| Superskill draft validation before save | `parseSuperskill`, `summarizeSuperskill` | `superskills/registry.ts:77-123` |
| Protocol shape validation for step JSON | `isComputerAction`, `isActionResult`, `isObservation`, `isProvenance`, `isMetadata` | `protocol/guards.ts:245, 593, 459, 543, 87` |
| Event bus to wrap (never subscribe raw) | `EventBus`, `ServerEvent`, `SERVER_EVENT_TYPES` | `server/events.ts:56-119` |

Patterns to copy:
- **Redact-then-freeze at the boundary.** Every artifact leaves the recorder through one
  constructor that deep-redacts and `Object.freeze`s (`audit.ts:54-66` pattern).
- **Trust cannot be forged.** Always pass observed provenance through `makeProvenance`
  (`provenance.ts:67-86`); never trust a `trust` field coming from UI text.
- **Approval binds the exact operation** (`operationFingerprint`, `approval.ts:85-105`);
  use it for "save this draft" so an old approval cannot save a modified draft.
- **Default deny for secret scopes** already exists for `SECRETS`
  (`server/permissions.ts:51`); extend the same doctrine to capture.

### 2.2 Real gaps (findings — capture would bypass existing redaction)

1. **EventBus forwards and retains raw payloads.** `EventBus.emit` stores `payload.data`
   unchanged in 512-event history and hands it to every listener
   (`packages/omnia/src/server/events.ts:86-104`); SSE replay re-sends it
   (`packages/omnia/src/server/server.ts:231-250`, route `packages/omnia/src/server/api.ts:880-883`).
   There is no scope check, no redaction, no per-listener filtering. A recorder subscribing
   to the raw bus receives everything with no SECRETS gate.
2. **Two different `redactSecrets` functions share one name.** Deep/pattern redactor at
   `security/redaction.ts:207`; literal vault-value replacer at `credentials/store.ts:100`.
   `server/computers.ts:25` imports the literal one, so `security/redaction.redactSecrets`
   never sees vault values. Capture code importing either name gets only half the job.
3. **Literal vault replacement skips short secrets.** `if (secret.length < 3) continue`
   (`credentials/store.ts:103`) — a PIN or 2-char password leaks by design.
4. **Literal replacement is exact-case, exact-byte only.** `value.split(secret).join(...)`
   (`credentials/store.ts:104`) misses base64, URL-encoded, JSON-escaped, UTF-16, lowercase,
   and 12+-char-substring forms — precisely the variants this contract must test.
5. **No value-based API in the deep redactor.** `RedactionOptions` has only
   `replacement`, `keys`, `maxDepth` (`security/redaction.ts:17-21`); there is no way to pass
   the vault's secret values, so arbitrary high-entropy secrets (TOTP seeds, generated
   passwords) that don't match the fixed patterns (`security/redaction.ts:58-69`) pass
   through untouched. TOTP seeds have no pattern at all.
6. **No encoded-variant or n-gram detection anywhere.** `redactText`/`secretFindings`
   (`security/redaction.ts:105-120, 228-267`) never decode base64/URL/UTF-16 and never check
   substrings, so any encoded form of a redacted secret survives. This is the central gap
   versus checks (c) and (d).
7. **Content envelopes only use `redactText`.** `content.ts:64` redacts envelope `content`
   with pattern redaction, not the vault-exact set; window/file text containing the vault
   secret yields a clean-looking envelope.
8. **`verifyTypedText` embeds typed text in results.** On success, evidence is
   `JSON.stringify({ length, hash, matched: probe })` with `probe = expected.trim().slice(0, 80)`
   (`server/computers.ts:1956-1963`); on failure the message includes
   `read.text.slice(0, 80)` (`server/computers.ts:1968`). A typed password lands in action
   results and in anything that records results.
9. **`browser_type` echoes the typed value.** Message `` `Typed into the page field: "${typed.value}"` ``
   and metadata `{ value: typed.value }` (`server/computers.ts:2245-2249`), unredacted.
10. **`read_clipboard` returns raw text plus a 4000-char preview.** `server/computers.ts:1090-1103`
    (preview at `:1100`) — gated only by `CLIPBOARD_READ`; if capture ingests action results
    it ingests the clipboard verbatim.
11. **`read_value` returns element value/text unredacted.** `server/computers.ts:1029-1031`
    (2000-char text slice), including password-field values.
12. **`credential.used` event carries a raw command prefix.** `command: command.slice(0, 200)`
    (`server/computers.ts:1776-1785`), and the bus does not redact it; inline secrets
    (`export TOKEN=...`, `curl -H "Authorization: ..."`) reach every bus listener.
13. **Command stdout/stderr are scrubbed only when a vault credential matched.**
    `server/computers.ts:1744-1752`; a command that prints `env` or `git config` is
    unredacted, and the scrubber is the weak literal one (findings 3-4).
14. **`contentFingerprint` is a 32-bit FNV-1a, not SHA-256.** `security/audit.ts:41-52`.
    Unsuitable as `redaction_hash`: brute-forceable for low-entropy values and collision-prone.
15. **`AuditTrail` is in-memory and mutable.** `security/audit.ts:213-243` (`clear()` wipes,
    no append-only file, no rotation, no retention, no hash chain). `appendAuditEvent`
    (`:195-211`) is pure and enforces nothing on disk.
16. **Superskill persistence is unscanned plaintext.** `SuperskillRegistry.persist`
    writes JSON with default file mode (no `0600`) at `superskills/registry.ts:148-151`;
    `parseSuperskill` (`:77-110`) never scans `instructions`, `methods.parameters`, or
    `bridge.env` (typed `Record<string,string>`, `superskills/types.ts:14`), so a draft
    bridge carrying an API key is persisted verbatim. `defaultSuperskillFile` has the same
    plaintext posture.
17. **Vault is plaintext JSON.** `credentials/store.ts:195-200` writes secrets in cleartext
    (mode `0600`, no encryption/keychain), and `list()` (`:202-206`) returns full secrets.
18. **`CLIPBOARD_READ` defaults to `"prompt"`, not `"denied"`.** `server/permissions.ts:42`,
    as do `SCREEN_READ` (`:37`) and `UI_CONTROL` (`:39`). A capture component that asks can
    get clipboard access with one prompt; "excluded by default" must be enforced in the
    recorder, not inherited from the gate.
19. **Protocol scope vocabulary lacks `SECRETS`.** `PERMISSION_SCOPES` has `clipboard` but no
    secrets (`protocol/types.ts:706-722`), while `OmniaScope` has `SECRETS`
    (`server/permissions.ts:16`). A recorder filtering by protocol scope cannot express
    "never secrets".
20. **Token patterns miss common shapes.** `security/redaction.ts:58-69` lacks `xoxc-`
    (`[baprs]` only), GitLab `glpat-`, `npm_`, `dop_v1_`, and OAuth query keys such as
    `code`, `otp`, `pin`, `sig`, `saml` (`redaction.ts:75` covers only
    token/api_key/auth/credential/key/password/secret). These are exactly the secrets a
    demonstration turns into a draft.
21. **SSE CORS is `*`.** `server/server.ts:238`; combined with finding 1, any web origin that
    can reach the port sees the raw event stream. Capture must not rely on this channel.

---

## 3. Default-exclusion enforcement (SECRETS and CLIPBOARD_READ)

### 3.1 Gate-level (permissions)

`SECRETS` is already denied by `DEFAULT_STATES` (`server/permissions.ts:51`). Tests:

```ts
import { PermissionManager } from "../../server/permissions"

test("SECRETS is denied by default and only grantable via explicit per-action approval", () => {
  const permissions = new PermissionManager()
  expect(permissions.state("SECRETS")).toBe("denied")
  expect(permissions.evaluate(["SECRETS"])).toMatchObject({ allowed: false, status: "denied" })
  const autonomous = new PermissionManager({}, "fully_autonomous")
  expect(autonomous.evaluate(["SECRETS"]).status).toBe("denied")          // denied wins over autonomy
  const approved = permissions.evaluate(["SECRETS"], {
    approval: { approved: true, scopes: ["SECRETS"] },
  })
  expect(approved.status).toBe("granted")                                  // explicit user approval only
})

test("capture scopes are an exact allowlist with no secret or clipboard scope", () => {
  expect([...CAPTURE_SCOPES]).toEqual(["UI_READ", "KEYBOARD", "POINTER"])
  for (const scope of ["SECRETS", "CLIPBOARD_READ", "CLIPBOARD_WRITE"] as const) {
    expect(CAPTURE_SCOPES).not.toContain(scope)
    expect(() => assertCaptureScope(scope)).toThrow(CaptureScopeError)
  }
})
```

`assertCaptureScope` lives in `recorder/scoped-events.ts` and throws `CaptureScopeError` for
`SECRETS`, `CLIPBOARD_READ`, `CLIPBOARD_WRITE` unconditionally (a compile-time `never` union
makes accidental use a type error too). Screenshots: `SCREEN_READ` is allowed only behind
`CAPTURE_SCREENSHOTS=false` default and an explicit UI toggle; §4 manual item 4.

### 3.2 Event-bus level

`recorder/scoped-events.ts` exposes only a branded, filtered source:

```ts
export const CAPTURE_EVENT_TYPES = [
  "action.started", "action.completed", "action.verified", "action.failed",
  "observation.created",
] as const

export const CAPTURE_FORBIDDEN_EVENT_TYPES = [
  "credential.created", "credential.updated", "credential.removed", "credential.used",
  "permission.requested", "permission.decided", "superskill.called",
] as const

const BRAND = Symbol.for("omnia.capture.scoped-event-source")

export function createCaptureEventSource(bus: EventBus): CaptureEventSource {
  const allowed = new Set<string>(CAPTURE_EVENT_TYPES)
  const listener: ServerEventListener = (event) => { /* forward only if allowed, after stripSecretData */ }
  const unsubscribe = bus.subscribe(listener)
  return Object.freeze({
    [BRAND]: true,
    unsubscribe,
    // Part A §2.7 backfill: bounded, windowed, and filtered through the same allowlist.
    // History before the capture start sequence is unreachable by construction.
    replayFrom(startSeq: number): readonly ServerEvent[] {
      return bus.since(startSeq).filter((event) => allowed.has(event.type)).map(stripSecretData)
    },
  }) as CaptureEventSource
}
export const isCaptureEventSource = (value: unknown): value is CaptureEventSource =>
  typeof value === "object" && value !== null && (value as Record<PropertyKey, unknown>)[BRAND] === true
```

`stripSecretData(event)` deletes keys matching `/credential|password|secret|token|clipboard/i`
from `event.data` before forwarding, and drops the event entirely if `event.type` is forbidden.
The recorder constructor accepts only `CaptureEventSource` (`isCaptureEventSource` guard
throws `Error("recorder requires a scoped capture event source")`), so subscribing the raw
bus is impossible.

Reconciliation with Part A §2.6 (normative): Part A classifies `credential.used` and
`permission.decided` as step *context*. This contract keeps those events out of the capture
allowlist entirely; if the recorder needs the signal, it derives a boolean/flag
(`credential_used: true`, `approval: "granted"`) from the parent action step and stores only
that derived value — never the event payload (`credential.used.data.command` can contain a
secret; see finding 2.2-12). `input.frozen`/`input.released` are Part A `ignore` events and
are absent from the allowlist as well. The zero-unclassified static test still applies in
Part A because the recorder's classification table remains total over `SERVER_EVENT_TYPES`;
the allowlist is the stricter runtime gate on top of it.

Tests (file `default-exclusion.test.ts`):

```ts
test("capture allowlist snapshot never contains credential, permission, or clipboard events", () => {
  expect([...CAPTURE_EVENT_TYPES]).toEqual([
    "action.started", "action.completed", "action.verified", "action.failed",
    "observation.created",
  ])
  for (const type of CAPTURE_FORBIDDEN_EVENT_TYPES) expect(CAPTURE_EVENT_TYPES).not.toContain(type)
})

test("recorder rejects a raw EventBus", () => {
  expect(() => new CaptureRecorder({ events: new EventBus({ serverId: "t" }) } as never))
    .toThrow("scoped capture event source")
})

test("scoped source drops credential.used even when it carries the vault secret", () => {
  const bus = new EventBus({ serverId: "t" })
  const source = createCaptureEventSource(bus)
  const recorder = new CaptureRecorder({ events: source, artifactsDir })
  bus.emit("credential.used", {
    data: { credentialId: "c1", command: `export TOKEN=${sentinels.vaultSecret}` },
  })
  bus.emit("action.completed", { data: { action: "click" } })
  expect(recorder.capturedEventTypes()).toEqual(["action.completed"])
  assertNoSecretBytes(artifactsDir, sentinels)      // §1 check is the tripwire
})

test("scoped replay is windowed and drops forbidden or secret-bearing events", () => {
  const bus = new EventBus({ serverId: "t" })
  bus.emit("credential.used", { data: { command: `export TOKEN=${sentinels.vaultSecret}` } }) // pre-window poison
  const startSeq = bus.lastSeq
  const source = createCaptureEventSource(bus)
  const recorder = new CaptureRecorder({ events: source, artifactsDir })
  bus.emit("action.completed", { data: { action: "click" } })
  const replayed = source.replayFrom(startSeq)
  expect(replayed.map((event) => event.type)).toEqual(["action.completed"])
  expect(JSON.stringify(replayed)).not.toContain(sentinels.vaultSecret)
  expect(isCaptureEventSource(recorder.events)).toBe(true)
})
```

### 3.3 The test that fails if capture ever subscribes to those scopes

Two tripwires, both required:
1. **Snapshot tripwire.** `expect([...CAPTURE_EVENT_TYPES]).toEqual([...])` and
   `expect([...CAPTURE_SCOPES]).toEqual(["UI_READ", "KEYBOARD", "POINTER"])` fail the moment
   anyone adds a credential/clipboard event or scope to the allowlist.
2. **Poisoned-bus end-to-end tripwire.** Emit `credential.used` (with `sentinels.vaultSecret`
   embedded in `data.command`), `permission.decided` with `scopes:["SECRETS"]`, and a
   clipboard-paste `action.completed` during capture, then run the full §1 scan. If capture
   ever records any of them, `scanArtifacts` returns findings and the test fails.

---

## 4. P0 security checklist per recorded draft

Every item below is a gate. `bun run script/recorder-review.ts --draft <path> --steps <dir> --journal <file>`
runs the automated gates and exits non-zero on the first failure. A draft may be saved only if
the script exits 0 AND a manual sign-off approval grant is valid.

### 4.1 Automated gates (command or assertion for each)

| # | Gate | Command / assertion | Reuses |
|---|------|---------------------|--------|
| A1 | No sentinel/variant/digest/n-gram/token-shape bytes in draft, steps, journal, filenames | `bun run script/recorder-review.ts --check zero-bytes` (wraps `assertNoSecretBytes`) | §1.4 |
| A2 | No pattern-detectable secret anywhere in the draft | `expect(secretFindings(draft)).toEqual([])` and `expect(containsSecret(draft)).toBe(false)` | `security/redaction.ts:228` |
| A3 | Vault echo gate: no vault secret or 12+ char substring of it | review script loads `CredentialStore.summaries()` only to get ids, reads secrets in-process, runs digest index; exits 1 on hit; test seeds a fake vault | `credentials/store.ts:85-107`, §1.4 |
| A4 | Deep redaction is a no-op on the draft (`redactSecrets(draft)` deep-equals draft) | `expect(redactSecrets(draft)).toEqual(draft)` | `security/redaction.ts:207` |
| A5 | Bridge env values are references, never literals | for every `env` value: `expect(value).toMatch(/^\$\{env:[A-Z][A-Z0-9_]*\}$/)`; assert no key matches `/(PASS|SECRET|TOKEN|KEY|CRED|AUTH)/i` unless its value is `[REDACTED]` | `superskills/types.ts:14` |
| A6 | Every step provenance is trusted and sourced from the demonstrating user | `expect(step.provenance).toMatchObject({ source: "user", trust: "trusted", authority: "user" })`; `assertPromptSafe(envelope)` for every `instructions` block | `security/provenance.ts:67-121`, `security/content.ts:250-264` |
| A7 | Draft scopes exclude secret/clipboard scopes and are a subset of demonstrated actions | `expect(draft.scopes).not.toContain("SECRETS")`, `…not.toContain("CLIPBOARD_READ")`; set-equality against the manifest computed by `requiredScopesForAction` for the recorded steps | `server/permissions.ts:189-272` |
| A8 | `type` steps never store literals in sensitive contexts | for steps marked `sensitive: true`: `expect(step.text).toMatch(/^\{\{[a-z0-9_.-]+\}\}$/)`; for all others, `expect(redactText(step.text)).toBe(step.text)` | `security/redaction.ts:105` |
| A9 | Draft parses under the production validator | `expect(() => parseSuperskill(draft)).not.toThrow()` | `superskills/registry.ts:77` |
| A10 | Save is bound to a valid, one-use approval | `expect(isApprovalGrantValid(grant, { action: "draft.save", resources: [draftId] })).toBe(true)` and `grant.usesRemaining === 1`; a re-save of a modified draft fails the fingerprint check | `security/approval.ts:85-179` |
| A11 | No literal tail of any action result | scan draft+journal for `/\b(?:Bearer|Basic)\s+\S{8,}/`, `-p\S{8,}`, `password[=:]\S+/i` and any run of 32+ base64url chars; exit 1 on hit | pattern list §1.3(c) |
| A12 | Journal hash algorithm and chain are valid | `bun run script/journal-verify.ts --file <journal>` recomputes every `redaction_hash` (HMAC-SHA-256) and the line chain; exit 1 on mismatch | §4.3 |

`recorder-review.ts` must accept `--fixtures <sentinels.json>` in CI; without fixtures it
still runs A2, A4-A12.

### 4.2 Manual review items (each has a command that produces evidence)

| # | Review | Command / assertion |
|---|--------|---------------------|
| M1 | Human sign-off that the draft describes what was demonstrated | approval grant `makeApprovalGrant({ action: "draft.save", resources: [draftId] }, "user", { maxUses: 1, expiresInMs: 15*60*1000 })`; test asserts a save without a grant throws and a grant with `approvedBy:"webpage"` throws (`ApprovalError`) |
| M2 | Read the final rendered instructions for contextual secrets the byte gates cannot know (account numbers read aloud into a draft) | `bun run script/recorder-review.ts --render --prose-scan` prints the rendered draft and runs the §1.3(c)/(d) scans over `instructions`; reviewer records the SHA-256 of the rendered draft in the approval grant metadata |
| M3 | Confirm bridge env references point at existing vault entries | `bun run script/recorder-review.ts --check-env-refs` resolves each `${env:NAME}` against `CredentialStore.summaries()` names and exits 1 on an unknown name |
| M4 | Confirm screenshots default off and sensitive steps have no frames | `bun test packages/omnia/src/recorder/screenshots.test.ts`: assert `CAPTURE_SCREENSHOTS === false` by default; enabling requires a `SCREEN_READ` approval grant; assert no frame file exists for steps marked `sensitive: true`; `bun run script/recorder-review.ts --frames` fails on any frame overlapping a sensitive step |
| M5 | Confirm consent banner and stop control are wired | `bun test packages/omnia/src/recorder/consent.test.ts`: capture cannot start without a `capture` grant with `expiresInMs <= 15*60*1000`; the stop control observes `input.frozen`/`input.released` on the raw bus (never through the capture allowlist) and the journal records only the derived flags `frozen:true`/`frozen:false` |
| M6 | Confirm the draft's `author` is a trusted identity, not model text | `expect(draft.author).toBe("user")` unless explicitly changed by the user through a settings action with its own approval fingerprint |

### 4.3 Journal PII controls

Record shape (NDJSON, one JSON object per line, UTF-8, `\n` terminated):

```json
{"seq":7,"at":1759000000123,"sessionId":"cap_2f9","type":"step.recorded","action":"type",
 "redaction":"pattern","redaction_hash":"hmac-sha256:6f1c...","prev_hash":"hmac-sha256:91ab...",
 "payload_digest":"hmac-sha256:c204...","bytes":418}
```

- **`redaction`** enum: `none` (payload contains no redactable value), `pattern`
  (`redactText` changed bytes), `vault_exact` (a vault value was replaced), `denied` (the
  step was dropped at the gate; no payload is written).
- **`redaction_hash` = HMAC-SHA-256(per-install key, canonicalJson(redacted payload))**,
  stored as `hmac-sha256:` + 32 hex chars (128 bits). It identifies *which* redaction
  happened for correlation/dedup and incident queries without retaining the value.
  It MUST NOT be a plain `sha256(value)`: low-entropy values (a 4-digit PIN) would be
  brute-forced from the file. The key comes from the OS keychain when available, else a
  `0600` key file outside the artifact root; key rotation starts a new file/chain.
- **`prev_hash`** chains lines: `line_hash = HMAC-SHA-256(key, prev_hash || canonicalJson(line))`.
  Append-only: open with `O_APPEND`, never `truncate`; a mutation of any byte makes
  `journal-verify.ts` fail.
- **Rotation:** size-based at 8 MiB or at session end, whichever first; renamed to
  `journal-<ISO8601>-<seq>.ndjson`, mode `0600`, never rewritten. The active file is never
  deleted by retention.
- **Retention:** default 7 days for journals, `maxCount` 32; artifacts have no default
  retention (deleted only by the user or by quarantine). Pruning uses an injected clock and
  only removes whole files older than the window. Config changes require a settings approval.

Tests (`journal.test.ts`):

```ts
test("redaction_hash is keyed and resists a 4-digit dictionary", () => {
  const key = randomBytes(32)
  const hash = redactionHash(key, "1234").replace("hmac-sha256:", "")
  expect(redactionHash(key, "1234")).toMatch(/^hmac-sha256:[0-9a-f]{32}$/)
  expect(sha256Hex("1234").slice(0, 32)).not.toBe(hash)
  const dictionary = Array.from({ length: 10_000 }, (_, i) => sha256Hex(String(i).padStart(4, "0")).slice(0, 32))
  expect(dictionary).not.toContain(hash)
})
test("tampering with one byte breaks the chain", () => { /* write 3 lines, flip byte in line 2, journal-verify exits 1 */ })
test("rotation preserves old files byte-for-byte", () => { /* write >8 MiB with injected clock, snapshot sha256 of old file, write more, digest unchanged */ })
test("retention removes only expired inactive files", () => { /* fake clock +7d, only old rotated files removed, active file kept */ })
test("contentFingerprint is never used as redaction_hash", () => {
  expect(redactionHash(key, "x")).not.toMatch(/^[0-9a-f]{8}$/)
})
```

---

## Appendix A — Full defect list (file:line)

1. `packages/omnia/src/server/events.ts:86-104` — raw payload stored/forwarded, no redaction or scope filter; history of 512.
2. `packages/omnia/src/server/server.ts:231-250` + `packages/omnia/src/server/api.ts:880-883` — SSE replay with raw payloads, CORS `*` (`server.ts:238`).
3. `packages/omnia/src/security/redaction.ts:207` vs `packages/omnia/src/credentials/store.ts:100` — duplicate `redactSecrets` names; `server/computers.ts:25` uses the weak literal one.
4. `packages/omnia/src/credentials/store.ts:103` — secrets shorter than 3 chars skipped.
5. `packages/omnia/src/credentials/store.ts:104` — exact, case-sensitive split/join only.
6. `packages/omnia/src/security/redaction.ts:17-21, 58-76, 105-120, 228-267` — no value-based redaction, no encoded-variant decode, no n-gram/substring scan.
7. `packages/omnia/src/security/content.ts:64` — envelope content redacted by pattern only.
8. `packages/omnia/src/server/computers.ts:1956-1963, 1968` — typed-text probe/readback in verification evidence/message.
9. `packages/omnia/src/server/computers.ts:2245-2249` — `browser_type` echoes typed value.
10. `packages/omnia/src/server/computers.ts:1090-1103` — raw clipboard text + 4000-char preview.
11. `packages/omnia/src/server/computers.ts:1029-1031` — element value/text returned unredacted.
12. `packages/omnia/src/server/computers.ts:1744-1752, 1776-1785` — stdout/stderr scrubbed only with a matched credential; `credential.used` carries 200 chars of raw command.
13. `packages/omnia/src/security/audit.ts:41-52` — FNV-1a fingerprint, not SHA-256/HMAC.
14. `packages/omnia/src/security/audit.ts:195-243` — in-memory mutable trail; no append-only file, rotation, or retention.
15. `packages/omnia/src/superskills/registry.ts:148-151, 77-110` — plaintext persist, default mode, no content/env scan; `packages/omnia/src/superskills/types.ts:14` — free-form `env`.
16. `packages/omnia/src/credentials/store.ts:195-200, 202-206` — plaintext vault file; `list()` returns secrets.
17. `packages/omnia/src/server/permissions.ts:37,42` — `SCREEN_READ`/`CLIPBOARD_READ` default `"prompt"`, not excluded.
18. `packages/omnia/src/protocol/types.ts:706-722` — no `SECRETS` scope in the protocol vocabulary.
19. `packages/omnia/src/security/redaction.ts:58-69, 75` — token/query patterns miss `xoxc-`, `glpat-`, `npm_`, `dop_v1_`, `code`, `otp`, `pin`, `sig`, `saml`.
20. `packages/omnia/src/security/approval.ts:55-74` — canonical `stableValue` is private; journal canonicalization must not fork a second implementation (export it or move it to `security/redaction.ts`).

## Appendix B — Acceptance checklist for the spike

- [ ] `bun --cwd packages/omnia test src/recorder/redaction/` green, including all
      §1.6 meta-tests (verifier proves it fires).
- [ ] `bun run script/verify-capture-artifacts.ts` green as a separate process, output free
      of sentinel material.
- [ ] `default-exclusion.test.ts` green, including the poisoned-bus end-to-end tripwire and
      the scoped-replay window assertion (pre-window `credential.used` never replayed).
- [ ] Every §4.1 gate maps to a line in `recorder-review.ts`; every §4.2 item maps to a
      command or an approval record.
- [ ] `journal.test.ts` green (keyed hash, chain tamper, rotation, retention).
- [ ] Appendix A findings triaged into the recorder design: findings 1-7 and 12-16 are
      "must not reuse as-is"; findings 8-11 and 17-19 are "capture must scrub results".
