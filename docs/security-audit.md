# Omnia security audit — 2026-10-09

Scope: Omnia control plane, desktop/agent identity, browser and command
boundaries, credential storage, security logging, and repository dependency/CI
controls. This is a code audit and remediation record, not a SOC 2 opinion or
proof that organizational controls operate effectively.

Two read-only subagent reviews examined the original claims and resource
isolation. Bounded implementation reviews addressed command environment/output
and browser isolation. Findings below distinguish source changes from deployed
controls. Running services have not been redeployed as part of this audit.

## Remediations implemented in the working tree

| Finding | Change and evidence |
| --- | --- |
| Empty operator bearer accepted as configuration | `server/server.ts` rejects an explicitly empty/blank token before initializing the server. Omitted tokens still generate 256-bit random credentials. |
| Unlimited failed bearer attempts | `server/server.ts` bounds online failures per socket peer and throttles subsequent invalid requests. Correct credentials and independently authenticated public routes are not locked out by another caller's attempts. Forwarded client IP headers are not trusted. |
| Wildcard response CORS | JSON/SSE no longer grant `*`. Explicit-origin checks cover preflight and actual requests; rejected origins get no grant. `server/server.test.ts` verifies allowed desktop preflight does not bypass actual-request auth. |
| Plaintext non-loopback Omnia listener | `server/server.ts` rejects non-loopback binds; remote access uses HTTPS termination/proxy/tunnel. Pairing discovery defaults to off. This does not validate the external proxy's TLS policy. |
| Headless upstream server warning-and-continue | `opencode/src/cli/cmd/serve.ts` requires a password. `opencode/src/server/server.ts` independently rejects passwordless non-loopback listeners. In-process and local-loopback library use can still be unauthenticated. |
| Standalone token printed to logs | `server/standalone.ts` writes generated connection credentials to a private file and logs only the listening URL/path. Environment-supplied tokens are never printed. |
| Autonomous execution without missing-scope approval | `server/permissions.ts` excludes missing `PROCESS_EXECUTE` and `SECRETS` scopes from the autonomy fallback. Explicit operator grants/approvals still work; denied scopes remain denied. |
| Wildcard credential cross-computer matching | `credentials/store.ts` makes legacy `computerId: "*"` credentials inert by default. `OMNIA_ALLOW_WILDCARD_CREDENTIALS=1` deliberately re-enables the old broad behavior; it is not a least-privilege setting. Stored legacy records are preserved. |
| Unsafe loader/startup env overrides | Shared `daemon/command-env.ts` validates keys/values and blocks loader/runtime startup overrides on Linux/macOS before execution. It preserves ordinary configuration and credential injection. |
| Only known exact secrets redacted | `credentials/store.ts` preserves exact-secret replacement and applies the shared pattern-based redactor to unknown recognizable credential formats. This is not complete data-loss prevention. |
| Batch steps could override session identity | `server/api.ts` validates every nested session claim before executing any step. Steps must use the proven outer/header session. |
| A token's own HMAC could impersonate an existing session | `server/api.ts` pins accepted session IDs to credential fingerprints within the server-context lifetime; a second credential's valid HMAC is insufficient. Bindings are capacity-bounded without eviction. Durable ownership and pre-registration across restart remain open. |
| Omitted browser tab reached global active page | `server/computers.ts` resolves an owned tab and passes that exact ID before querying dialogs or dispatching page operations. Sessions with no owned tabs cannot adopt another session's tab. Ownership is scoped to computer registration and browser controller. |
| Run ownership/billing used server-global sign-in | Run routes and route-level capability checks resolve the presented token's profile. `server/runs-api.test.ts` verifies account B cannot see/delete account A's scheduled run and B's new run is billed/owned as B. Root-token requests keep the operator-profile fallback. |
| Volatile/wipeable audit only | New `security/journal.ts` writes private JSONL, authenticates sequence/previous-record chain with HMAC-SHA256, verifies on reopening, prevents concurrent writers and final-path symlink use, and flushes appends. Server admission/status and privileged event metadata are recorded without request bodies, page contents, tokens, or query strings. Audit-storage failure prevents further admission. |
| Weak audit content fingerprint/clear API | `security/audit.ts` uses SHA-256 rather than FNV and removes `clear()`. The legacy in-memory cache remains a convenience API; the server uses the durable journal. |
| Dependency audit was advisory only | `.github/workflows/audit.yml` no longer has `continue-on-error` or manifest-only trigger filtering. High/critical findings fail the job. Repository branch protection must still require it. |
| No source dependency inventory | `opencode/script/security-sbom.ts` generates CycloneDX 1.6 inventory from `bun.lock`, including package versions and available SHA-512 integrity hashes. Audit CI retains it. It inventories the whole repository lockfile, not platform-artifact reachability. |
| Security areas absent from CODEOWNERS | Existing reviewers now cover Omnia, server/auth/CLI, core, infra, and workflow changes. Confirm reviewers have appropriate access in this fork and require owner review in branch protection. |

## New high-priority findings still open

### Account-to-computer ownership is not authoritative

Evidence: `auth/github.ts` mints a desktop-kind token after public OAuth;
`server/api.ts:isTrustedDesktopRequest` checks token kind, not ownership of the
selected computer; registration passes caller-supplied keys/IDs into
`server/remote.ts:RemoteRegistry.claim`. Neither remote entries, local computer
entries, nor persisted pairing offers record a durable profile owner.

Impact requires a reachable deployment with OAuth and shared registered
computers. It is distinct from operator authorization: client tokens **cannot**
change operator permission settings, but another signed-in desktop may still
target global computer/credential resources. Permission and billing gates limit
specific operations; they do not establish ownership.

Required remediation: persist owners/key reservations before registration;
capture owners from authenticated token profiles; bind offers to their creator;
authorize every computer/credential/input/CUA route; filter lists, sessions,
live events and replay. Quarantine unassigned legacy IDs/credentials pending
explicit assignment. Do not infer ownership from `auth.status().profile`: it is
the last global sign-in and can change while older client tokens remain valid.

### Remote re-registration does not prove private-key possession

Evidence: `server/remote.ts:RemoteRegistry.claim` permits ID reuse when the
submitted public key equals the existing public key. Registration itself has no
signed ownership challenge. Knowing a victim ID/public key can rotate its
runtime bearer and disconnect it. Signed command polling/results remain
protected, so this is not proven result forgery or command interception.

Required regression: client B submits A's ID/public key without A's private
key; A's registration/token must remain unchanged. Coordinate a signed
registration/reconnect protocol with the desktop before altering compatibility.

### Browser downloads and HTTP-auth challenges remain global

Evidence: `server/computers.ts` download enumeration and auth challenge
operations use controller methods with no tab/session ownership metadata;
`desktop/src/main/omnia/browser-view.ts` returns the global download registry.
Empty-session page operations are now blocked, but a session owning one tab
can still encounter another tab's challenge. Download URLs, filenames and disk
paths can cross session boundaries; file bytes are not returned by listing.

Required remediation: attribute downloads and auth challenges to originating
tab IDs in the controller/remote protocol, then authorize by owned tab. URL
matching is not reliable ownership evidence.

### Image-save path containment can follow a parent symlink

Evidence: `browser/image-file.ts:resolveImageSavePath/writeImageFile` and
`server/computers.ts` use lexical containment before writing. `wx` protects the
final filename, not symlink ancestors. A restricted caller with access to a
pre-existing allowed-root symlink may create a new image outside that root.

The same-OS-user attacker already has that user's filesystem authority; this
is a confused-deputy problem for restricted remote callers or shared-temp
attackers, not new OS privilege escalation by itself. Revalidate resolved
ancestors and use race-resistant directory-bound file creation where supported.

### Command execution is not a workspace jail

The env restrictions do not sandbox approved shell/Python/Node programs, block
all destructive operations, or constrain inherited runtime environment. `cwd`
does not constrain where commands read/write, and check-then-spawn directory
checks can race. A shell-string denylist cannot enforce a filesystem jail.
An `OMNIA_STRICT_JAIL` claim requires an actual OS sandbox/container boundary,
platform-specific enforcement, and escape regressions—not a flag alone.
Unrestricted GUI/keyboard access can also operate a terminal: denying the
`run_command` API alone is not an OS-wide prohibition on process execution.

## Dependency evidence

`bun audit --audit-level=high` reports **143 advisories: 7 critical, 136 high**.
This is an advisory count, not 143 remotely exploitable production paths.
Findings include Electron 42.3.3 sandbox/protocol issues, MCP SDK 1.29.0 OAuth
credential redirection, updater transitive dependencies, Seroval, Astro and
archive/XML parsers. Build-only dependencies and runtime dependencies need
separate reachability triage.

`bun audit fix --dry-run` refused with `bun.lock does not match package.json`.
The repo also pins patches for MCP SDK, Effect, Solid, and other packages.
Reconcile lockfile/manifests, carry forward and test patches, and upgrade
compatible vulnerable versions before marking the CI control green. No broad
major-version replacement or vulnerability suppression was applied.

Inventory generated locally: **3,566 locked components**. Artifact signing,
build provenance attestations, verification at installation, and platform
artifact SBOMs remain separate release controls. The current local macOS build
is unsigned; it is not a notarized production release.

## Qualifications to the original audit

- A 256-bit random machine bearer is not practically guessable. Online failure
  controls limit abuse; human MFA is a separate identity-provider requirement.
- Preflight is normally unauthenticated; the flaw was unrestricted origins,
  not the mere fact that preflight preceded bearer authentication.
- Default `SECRETS` was already denied before the autonomy fallback. The new
  guard also prevents autonomy granting it when configured as prompt.
- `MemoryStore.forget()` already iterates matching pages. Retention scheduling,
  consent and deletion evidence are separate missing controls.
- Plaintext credentials readable by the same OS user remain an at-rest risk,
  but a process already executing as the runtime owner also has substantial
  authority. Treat keychain/KMS separation as a real design requirement,
  rather than claiming that file permissions encrypt data.
- Plan capability markers and 404 routes are not implemented SSO/RBAC. Do not
  present them as security-control evidence.

## Verification and operating-control gaps

Meaningful regressions cover denied origins, actual-request auth after allowed
preflight, bearer throttling and expiry, valid-client availability, empty token,
network bind rejection, nested/cross-credential sessions, caller-owned runs,
tab isolation, env injection, redaction, journal integrity, and log secret
omission. The retained `tests/exploits/` proofs assert that old vulnerabilities
exist; some therefore intentionally fail after remediation. They have not been
rewritten to claim compliance.

The final review also caught two introduced bugs, now regression-tested:
public OAuth routes accepting session proofs from invalid bearer strings, and
unbounded pre-auth durable logging. Session ownership mutation now requires an
authenticated bearer; clients are limited to 512 bindings, with reserved
operator capacity. Rejected/anonymous traffic writes at most 40 generic durable
records/minute globally. Public status traffic cannot consume an admission
quota shared with OAuth completions or signed Stripe webhooks; signed webhooks
require a durable record after signature verification and before mutation.
Request paths are capped at 256 characters, individual
journal records at 8 KiB, and each journal at 64 MiB. Rejections beyond the log
budget are not individually recorded. A global public-admission limiter was
removed after review showed it could starve independently authenticated routes.
These budgets reduce unauthenticated
storage abuse; they do not replace upstream rate limiting, storage monitoring,
archival/rotation or recovery procedures.

Observed verification for this pass:

- Omnia package typecheck: passed.
- Runtime/security suites: **686 passed**, **0 failed**, **7 existing todos**.
  Two tests that freeze/move input on the real desktop were filtered out; a
  prior live-X11 run failed to settle the pointer and is not claimed as passed.
- OpenCode auth/listener suites: **26 passed**, **0 failed**.
- Desktop typecheck: passed.
- OpenCode package typecheck: blocked only by four existing errors in the
  unrelated untracked `src/tool/git/` work. The new CLI typed-error issue was
  corrected using the existing `CliError` path.
- `git diff --check`: passed.
- Dependency audit: failed with **7 critical / 136 high** advisories.
- Automated dependency remediation dry-run: blocked by manifest/lock mismatch.

Still required: OS keychain/KMS-backed secret storage; token expiry/revocation
and rotation lifecycle; enforced SSO/MFA/SCIM and durable resource RBAC;
authenticated billing-state integrity; independently anchored/forwarded audit
logs and retention; automated encrypted backups with restore exercises;
release provenance and signing; security SLO/alerts; privacy inventory,
retention/deletion policy, provider/vendor DPAs, and penetration testing.

An HMAC chain with a local key detects edits/reordering on verification, but
cannot alone prove absence of deleted suffixes, complete-log rollback, or an
owner-controlled rewrite. Forward chain heads/records to an independent
collector. Default journals are per server instance; an explicit
`OMNIA_AUDIT_FILE` resumes a verified chain. A crashed writer leaves a lock:
preserve the files, verify the process is dead, and perform documented recovery
instead of silently deleting evidence. Windows directory ACLs must be verified
operationally; POSIX mode checks do not validate Windows ACLs.

See [security-operations.md](security-operations.md) for incident and
backup/rollback procedures. Procedures are not evidence that they have run.
