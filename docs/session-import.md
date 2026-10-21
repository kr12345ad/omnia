# Session Import

Omnia can bring session history from an existing OpenCode install (and from the
Codex CLI) into its own database. The importer reads other applications' files
**read-only** and never modifies them; everything it writes goes into the Omnia
database.

## Where it is offered

- **First launch.** Step 2 of the onboarding wizard lists what was found on this
  computer, lets the user pick sources, and shows what was imported. Any step can
  be skipped.
- **Settings → General → Advanced → Sessions.** The same list, re-runnable at any
  time. In the browser build the section says the feature is desktop-only,
  because the work happens in the Electron main process.

Both screens call the desktop bridge (`importSourcesDetect` and
`importSessionsRun` in `packages/desktop/src/preload`), and after a successful
import they invalidate the renderer's cached queries so session and project lists
refresh without restarting the app.

## Sources

| Kind | Location | Notes |
| --- | --- | --- |
| OpenCode | `$XDG_DATA_HOME/opencode/opencode*.db` (default `~/.local/share/opencode/`) | Any database with `session` and `message` tables and at least one session. The Omnia database itself is excluded. |
| Codex | `$CODEX_HOME/sessions/**/rollout-*.jsonl` (default `~/.codex/sessions/`) | Files over 50 MB are skipped with an error instead of being read into memory. |

Source previews show the number of sessions, number of messages and the date
range, so an empty or unrelated database is visible before anything is imported.

## Destination

The importer writes to `<userData>/OMNIA.db` — the same database the local server
reads, for example `~/.config/io.omnia.desktop.dev/OMNIA.db` in a development
build. The server must have created it already (it does before the first window
is shown); an import against a missing database fails with
`Omnia database not found: …` rather than creating a half-initialised file.

Report progress and history are recorded in `<userData>/session-import.json`
(created with `0600`). The ledger stores per-database totals for OpenCode
sources and one entry per imported Codex file.

## What is copied from an OpenCode database

Rows are copied verbatim, keeping their original ids, through column
intersection: a column that exists in the destination but not the source is left
alone, and the other way around.

1. **Projects.** Every `project` referenced by an imported session, plus its
   `project_directory` rows. If the source no longer has the project row, a
   placeholder is created from the session's directory so the session remains
   reachable.
2. **Sessions.**
3. **Session-scoped history.** `message` and `part` (what the timeline renders),
   `session_message` (the durable V2 history a continued session is resumed
   from), `todo`, `session_share`, and any other table in the destination that
   carries a `session_id` column.

Never copied:

- `session_input` — prompts an installation has admitted but not run yet.
  Importing them would re-run another install's unfinished work here.
- Credentials, accounts, configuration and caches (`credential`, `auth`,
  `account*`, `kv`, `instruction_blob`, …). Sign-in and settings stay local to
  this computer.

Databases created before the `session_v2` → `session` rename can still carry a
foreign key from `session_message` to the old `session_v2` table. When that
constraint is present the importer mirrors each imported session into
`session_v2` as well, so durable history can be inserted instead of failing every
row.

## What a Codex rollout becomes

Each `rollout-*.jsonl` file becomes one session in Code mode:

- Session title comes from the first user message, the working directory from
  `session_meta` (or `turn_context`), and the model from `session_meta`.
- `response_item` messages, reasoning blocks and tool calls become messages with
  `text`, `reasoning` and `tool` parts; a `function_call` is paired with its
  `function_call_output` by `call_id` wherever it appears in the file.
- Every row is written to satisfy the V1 session schemas (`SessionV1.Info` and
  `SessionV1.Part`): user messages carry an agent and model, assistant messages
  carry their parent, model, mode, path, cost and tokens, and completed tool
  parts carry an object input, a title, metadata and start/end times. Rows that
  miss those fields render as broken turns, so the tests check them explicitly.
- A file is imported once; the ledger's entry for its path records the session it
  produced.

## Guarantees

- **The source is never written.** OpenCode databases are opened read-only and
  Codex files are only read.
- **Re-runnable, resumable.** Every insert is `INSERT OR IGNORE` on a primary
  key, so a second run adds only what is missing. Re-running after new messages
  were appended to an already-imported session picks those messages and parts up.
- **Interruptible.** Sessions are committed in chunks of 50 and rows are read in
  pages of 2 000, so a two-gigabyte source neither holds one enormous write
  transaction open nor materialises itself in memory. A failure part-way through
  keeps the chunks that already committed and names the table and session range
  that failed; running the import again continues from there.
- **Works while the app is running.** The destination connection waits up to five
  seconds for the app's own writer instead of failing with `SQLITE_BUSY`, and a
  final `wal_checkpoint(TRUNCATE)` keeps the journal from staying huge.

Measured on a 2 GB OpenCode database (549 sessions, 49 187 messages, 199 660
parts): about 11 seconds and roughly 350 MB peak RSS, against 70 seconds and
276 MB for the earlier single-transaction version that also dropped
`session_message` and `todo`.

## Troubleshooting

| Symptom | Cause | What to do |
| --- | --- | --- |
| `Omnia database not found` | The local server has not created the database yet. | Start the app normally first, then import from Settings. |
| A source is listed but the import fails reading it | The source file cannot be opened. | Check that the file exists and is readable by the current user; re-scan. |
| An error naming a table and a session range | A row violated the destination schema (usually a foreign key). | Nothing is corrupted: re-run once the app has been updated, or report the table name from the message. |
| Imported sessions missing from the sidebar | The renderer was showing a cached list. | The import invalidates those queries; re-scan, then switch tabs. Sessions are also visible after a reload. |
| A Codex file reports "larger than 50 MB" | The rollout exceeds the per-file limit. | Split the file or import the neighbouring files; the rest of the selection still imports. |

## Developer notes

- `packages/desktop/src/main/session-import.ts` — detection, parsing and both
  import routines. `session-import.test.ts` covers rollouts, idempotent re-runs,
  appended messages, chunk boundaries, durable history/todo copying, and that the
  source is untouched.
- `packages/desktop/src/main/ipc.ts` — the `import-sources-detect` and
  `import-sessions-run` channels and the destination path.
- `packages/app/src/components/settings-sessions.tsx` and
  `packages/app/src/components/onboarding-wizard.tsx` — the two surfaces.
- `bun test src/main/session-import.test.ts` and `bun typecheck` from
  `packages/desktop`.
