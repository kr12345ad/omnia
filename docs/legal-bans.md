# Legal bans

A ban blocks an installation from running Omnia: agents, sessions, the local
server and model access all stop, and the session database is encrypted at rest.
Nothing is deleted, and lifting the ban restores the same bytes.

## Subjects

A ban targets one of two subjects, and either one blocks a caller:

| Kind | Value | Blocks |
| --- | --- | --- |
| `account` | lowercased email | every installation signed into that account, on any machine |
| `installation` | lowercased 32-hex fingerprint | that machine only, signed in or not |

Account bans are what make enforcement follow a person through a reinstall, a
new laptop, or a different OS user. Two machines with the same account email are
blocked independently; a machine is only blocked once it reports the banned
account (or once the client has sealed locally, which is sticky until lifted).

Records live in the enterprise store (`enterprise.json`, `legalBans`) and are
never deleted: lifting sets `liftedAt`/`liftedBy`, so the same file explains why
the account was blocked and who released it. `legal.ban_applied`,
`legal.ban_lifted` and `legal.login_blocked` are written to the audit log.

## Operator commands

```sh
omnia-server ban --email alice@example.com --reason "Terms breach"
omnia-server ban --fingerprint 8b971e7a7450184d6ec77c39361b3c48 --reason "Device abuse"
omnia-server unban --email alice@example.com
omnia-server unban --fingerprint 8b971e7a7450184d6ec77c39361b3c48
omnia-server bans [--json]
```

`--reason` is required and is the text the blocked user reads on the ban screen.
A repeated `ban` for an active subject updates the reason instead of stacking
records. A running control plane picks the change up from the file without a
restart; only a lifted ban can stop blocking, and only when the endpoint
answers `banned: false`.

A banned account is also refused at password sign-in (`store.login`), so a
valid credential cannot mint a client token while the ban is active.

## Endpoint contract

`GET /v1/legal/status?fingerprint=<id>&email=<address>&version=<terms>`

Public by design: a blocked installation must learn it is blocked before it
holds any credential. It answers only ban state for the presented identifiers:

```json
{ "ok": true, "banned": true, "reason": "Terms breach", "bannedAt": 1792551349352 }
```

A list form is also accepted by the client, which is what lets an operator
publish bans as a static JSON file (`{ "bans": [{ "email": "...", "reason": "..." }] }`
or a keyed map) instead of running a server. Entries match on `email` or
`fingerprint`; a keyed map is read as an email when the key contains `@`.

## Client behaviour

1. `legal.startup()` runs before the local server exists. A ban seals
   `OMNIA.db` with AES-256-GCM into `OMNIA.db.sealed` and removes the plaintext
   plus its WAL; the key is stored in fuse locations outside the app data folder.
2. The renderer shows the ban screen with the reason, the date, the installation
   fingerprint and an appeal mailto. No agent, session or server runs behind it.
3. A sign-in that reveals an account ban re-checks immediately, seals, and
   relaunches into the ban screen.
4. `legal.refresh()` (the "Check again" button) restores the database only on an
   explicit `banned: false`; an unreachable endpoint can never lift a ban.
5. An empty `email` (signed out) means the check is fingerprint-only.

## Verification

- `bun run legal:smoke` in `packages/desktop` runs the whole lifecycle against a
  throwaway fingerprint, fuse and local endpoint, using a copy of a real
  database: installation ban, account ban, reinstall, offline refusal, unban,
  byte-identical restore, and an unaffected account on another installation.
  It never touches this machine's fuse or data.
- `packages/omnia/src/server/legal-status.test.ts` covers the public route,
  including a ban written by a second process against a running server.
- `packages/omnia/src/enterprise/store.test.ts` covers normalisation, audit,
  persistence across reopen, and login refusal.
- `packages/desktop/src/main/legal.test.ts` covers the client sending the account
  email, matching account entries in a published list, sealing, and restoring.

The client-side check is a control, not a boundary: a tampered build can ignore
it. The durable controls are the server refusing sign-in for a banned account and
the sealed database on disk.

An account ban matches the email on the signed-in profile. Work-email sign-ins
always carry one, and Google profiles do; a GitHub account that has no public
email exposes only a numeric id, which this version does not use as a subject.
For those accounts, ban the installation fingerprint instead — or ask for
provider-id bans, which would need the operator to know the id.
