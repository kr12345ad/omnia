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

## High-priority findings closed in the current working tree

### Account-to-computer ownership is profile-bound

Evidence: `server/api.ts` records the presented desktop profile on new remote
registrations and uses that owner for list/capabilities/event/pairing filters
and every `/v1/computers/:id` route except the runtime's own signed transport.
Local computers remain available to the signed-in user; the deployment operator
token retains global reach. Remote entries that predate ownership binding are
quarantined from client tokens instead of being assigned to the first caller.

Regression: `server/operator-identity.test.ts` verifies another account cannot
list or target the computer and that an unowned legacy remote entry is hidden
from client tokens but visible to the operator.

Residual: remote ownership is in-process and disappears on restart; the runtime
re-establishes it when it re-registers. Local computer resources remain
installation-scoped rather than per-profile. Durable key reservations and a
legacy credential-assignment workflow are still required for multi-tenant
deployments.

### Re-registration requires proof of private-key possession

Evidence: `server/remote.ts:RemoteRegistry.claim` issues a 32-byte challenge on
every successful registration and requires an Ed25519 signature over the
computer id plus the current challenge, timestamped inside the replay window.
The challenge rotates on success, so a submitted public key alone cannot rotate
another runtime's bearer or disconnect it.

Regression: `server/remote-lifecycle.test.ts` covers missing, forged, expired,
replayed and valid registration proofs; `server/auth.test.ts` covers the HTTP
path and challenge return value.

### Browser downloads and HTTP-auth challenges are tab-scoped

Evidence: download and auth-challenge summaries now carry the originating
`tabId`; `server/computers.ts` passes the session's owned tab ids to the
controller and filters unattributed records for restricted sessions. Answering
a challenge requires ownership of its tab, even when the session owns a
different tab. `desktop/src/main/omnia/browser-view.ts` attributes new records
from the originating webContents tab.

Regression: `server/computers-browser.test.ts` verifies that a session cannot
see another tab's downloads or answer its auth challenge.

### Image-save containment resolves symlinked ancestors

Evidence: `browser/image-file.ts:resolveImageSavePath` now resolves the deepest
existing ancestor of both the allowed root and the target directory, then
requires real-path containment before `mkdir`/write. A pre-existing parent
symlink pointing outside the root is rejected.

Regression: `browser/image-file.test.ts` covers a parent symlink escape and a
normal nested path. Residual: the check and the subsequent write are still
separate syscalls, so a same-user attacker who can replace the directory in that
window can race it; directory-bound file creation would close that gap.

## Residual design limits

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

`bun audit` now reports **0 critical and 0 high advisories** (12 moderate and
6 low remain). This is an advisory count, not a count of remotely exploitable
production paths. The dependency pass aligned the lockfile with `package.json`,
applied fixes inside existing ranges, and upgraded across major versions where
the advisory had no in-range fix: Astro 7.4.2, Starlight 0.41.11, Electron
42.11.16, Vite 7.3.7/6.4.4/8.3.5, Undici 7.30.1/6.29.1/8.12.2, Zod 4.6.7,
MCP SDK 1.32.0, Hono 4.13.11, `@actions/artifact` 6.3.1, and Seroval 1.6.3.
The MCP 1.29 OAuth patch was rebased onto 1.32.0.

Starlight is deliberately held at 0.41.11: 0.42 parses Tabs/Steps/FileTree at
render time through Sätteri, whose Node WASI binding cannot run in the
Cloudflare adapter's workerd prerenderer. Astro 7 still supplies the AVIF RCE
fix. The Cloudflare prerender pass runs in Node (`prerenderEnvironment: "node"`)
so the remaining markdown processor never loads a WASI binding in workerd.

The remaining moderate/low findings are in transitive ranges blocked by their
dependents (AWS SDK XML tooling, `@jsx-email/cli`'s React Router 6 line,
`qs`/`srvx`/`fastify`), and in build-only tools. They are not suppressed: CI
continues to fail on any newly introduced high or critical advisory.

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
- Omnia full suite: **2319 passed**, **0 failed**, **4 skipped**, **7 todos**.
  The real-X11 input-freeze tests ran and passed; the live-harness measurement
  remains opt-in because it needs a scratch window, not because it fails.
- OpenCode typecheck: passed; MCP OAuth suite: **11 passed**, **0 failed**.
- App typecheck: passed; unit suite **756 passed**, browser suite
  **166 passed**, **0 failed**.
- Desktop, console app, stats app, core, session-ui, UI, enterprise, server,
  TUI, SDK, plugin, CLI, and stats typechecks: passed.
- Web docs build: passed under Astro 7.4.2 with Starlight 0.41.11 and the Node
  prerender pass.
- `git diff --check`: passed.
- Dependency audit: **passed the high/critical gate**, `0 critical / 0 high`
  (12 moderate, 6 low).

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
