# Security incident, recovery and rollback procedures

This runbook defines required actions and evidence. It does not claim that
alerting, off-host retention, backup scheduling or restore exercises are
already deployed. Assign a named incident lead and infrastructure owner before
using this as an organizational control.

## Severity and triage

- **SEV-1:** suspected unauthorized command execution, credential exposure,
  cross-account computer access, forged billing entitlement, or journal
  integrity failure. Contain the affected deployment immediately; preserve
  evidence before investigation or rollback.
- **SEV-2:** failed audit writes, unavailable auth/billing enforcement, failed
  backup/restore, or a security-related outage without confirmed compromise.
  Fail closed on the affected privileged surface and assess SEV-1 escalation.
- **SEV-3:** a non-reachable dependency advisory or configuration drift.
  Document reachability, remediation owner and deadline; do not suppress it
  solely to make CI pass.

Record incident ID, UTC timestamps, lead, scope, suspected entry point,
affected profiles/computers, action taken, communication, and recovery evidence.
Keep secrets, command output and screenshots out of incident tickets unless
stored in restricted evidence storage.

## Containment and evidence

1. Restrict the external proxy/tunnel route for the affected deployment. Keep
   the internal listener on loopback. Do not expose its HTTP port on the LAN.
2. Preserve the installed artifact/version/hash, configuration permissions,
   security JSONL records and chain heads, application logs, and proxy logs.
   Query strings, request bodies and credentials must not be added to logs.
3. If the runtime owner or host is compromised, treat local journal keys and
   machine bearers as compromised. A local HMAC chain is not independently
   anchored evidence; obtain the off-host collector copy where configured.
4. Revoke affected client tokens through operator provisioning/sign-out and
   replace exposed server/provider credentials. Reconnect devices using new
   credentials and keys. Verify the old credentials are rejected; replacing
   a file alone does not rotate a running process.
5. Investigate ownership checks, session binding, operator approval and the
   matching dependency advisory. Preserve a minimal repro and regression test.

## Backup and restore

The infrastructure owner must select and measure **RPO** and **RTO** based on
the actual deployment. Do not describe an aspirational target as achieved.

- Back up application databases, their related blobs, schedule/credential/auth
  configuration, and audit records. Treat auth/vault copies and journal keys as
  secrets. Use encrypted, access-controlled off-host storage with versioning.
- Do not copy an active SQLite DB without a consistent snapshot. Use SQLite's
  online backup API or a maintenance window. Include referenced blobs and the
  matching configuration generation. JSON and audit snapshots also need a
  documented consistent snapshot strategy.
- Restore first into an isolated profile/deployment with scheduling, computer
  pairing and outbound execution disabled. Never overwrite a live user profile
  as a restore experiment.
- Verify SQLite integrity, expected session counts/IDs, blob references,
  scheduled-run ownership, vault decryption/secret access, file permissions,
  and journal chain integrity. Corrupt or unassigned state stays quarantined.
- Record snapshot timestamp, source artifact, restore duration, data-loss
  interval, integrity results, owner and approval. Run exercises on a schedule
  and after storage/identity migrations. A passing unit test is not an off-host
  restore exercise.

## Release rollback

1. Identify the last verified artifact and its expected hash/signature. Retain
   the failing artifact for investigation.
2. Confirm schema compatibility before reverting binaries. Restoring an older
   executable does not undo data migrations or compromised credentials.
3. Stage the prior artifact separately and verify it. Replace binaries through
   the normal deployment mechanism during a maintenance window; retain backups.
4. Verify health and authentication, rejection of old revoked credentials,
   caller/computer ownership, permission gates, security logging and session
   preservation before reopening external access.
5. Record rollback decision, executor, hashes, timeline and verification output.

## Audit failure recovery

Audit storage failure causes new privileged admission to fail. Preserve the
JSONL, key and lock before maintenance. If a lock remains after a crash,
establish that no process is writing, save a restricted evidence copy and
verify the existing chain. Do not truncate a partial record or rewrite history
silently; retain the original and document the recovery boundary/new journal.
If a collector is configured, reconcile its last accepted head before resume.

No automatic journal retention deletion is implemented. Define the regulatory
and contractual retention period, collector controls, storage limits and
authorized deletion process before enabling such deletion.
