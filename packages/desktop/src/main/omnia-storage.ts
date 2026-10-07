import { randomUUID } from "node:crypto"
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

export function omniaStorageEnv(userDataPath: string, env: NodeJS.ProcessEnv = process.env) {
  const root = resolve(userDataPath)
  const destination = join(root, "OMNIA.db")
  const configured = env.OMNIA_CONFIG_FILE === join(root, "config", "OMNIA.json") && env.OPENCODE_DB === destination
  const data = join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode")
  const production = join(data, "opencode.db")
  const candidates =
    !configured && !existsSync(destination) && existsSync(data)
      ? readdirSync(data)
          .filter((name) => /^opencode(?:-[\w.-]+)?\.db$/.test(name))
          .map((name) => join(data, name))
      : []
  const legacy = configured
    ? env.OMNIA_LEGACY_DB
    : env.OPENCODE_DB
      ? env.OPENCODE_DB === ":memory:"
        ? undefined
        : isAbsolute(env.OPENCODE_DB)
          ? env.OPENCODE_DB
          : join(data, env.OPENCODE_DB)
      : candidates.includes(production)
        ? production
      : candidates.length === 1
        ? candidates[0]
        : undefined
  if (!env.OPENCODE_DB && candidates.length > 1 && !candidates.includes(production)) {
    throw new Error(
      "Multiple legacy OpenCode databases found; select the Omnia source with OPENCODE_DB before migration",
    )
  }
  return {
    OPENCODE_DB: destination,
    OMNIA_CONFIG_FILE: join(root, "config", "OMNIA.json"),
    OMNIA_LEGACY_DB: legacy ?? "",
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
  }
}

// Run before importing the server: core captures DB/XDG paths at module evaluation.
// Only a new destination is migrated. The source is opened read-only and is never
// pruned. A full online SQLite backup retains ambiguous history for recovery.
export async function migrateOmniaStorage(destination: string, source?: string) {
  if (!isAbsolute(destination)) throw new Error("Omnia database path must be absolute")
  if (lstatSync(destination, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error("Refusing to open Omnia database through a symlink")
  }
  if (existsSync(destination) || !source || resolve(source) === destination) return
  if (!existsSync(source)) throw new Error(`Legacy Omnia source database not found: ${source}`)
  const { DatabaseSync, backup } = await import("node:sqlite")
  const directory = join(dirname(destination), "migration-backups", randomUUID())
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const snapshot = join(directory, "opencode-original.db")
  const temporary = join(directory, "OMNIA.db")
  const original = new DatabaseSync(source, { readOnly: true })
  try {
    closeSync(openSync(snapshot, "wx", 0o600))
    await backup(original, snapshot)
  } finally {
    original.close()
  }
  writeFileSync(
    join(directory, "RECOVERY.txt"),
    [
      `Source (untouched): ${source}`,
      `Full SQLite backup (including unclassified sessions): ${snapshot}`,
      `Destination: ${destination}`,
      "Selection: session and session_v2 metadata.mode work/code plus parent/fork descendants; unknown schemas block publication.",
      "Only the isolated copy is filtered. To inspect unclassified history, open the full backup read-only with SQLite.",
      "Do not replace an active OMNIA.db: recover missing history separately to avoid overwriting new sessions.",
      "",
    ].join("\n"),
    { mode: 0o600, flag: "wx" },
  )
  const full = new DatabaseSync(snapshot, { readOnly: true })
  try {
    closeSync(openSync(temporary, "wx", 0o600))
    await backup(full, temporary)
  } finally {
    full.close()
  }
  const db = new DatabaseSync(temporary)
  try {
    db.exec("PRAGMA foreign_keys = OFF; PRAGMA journal_mode = DELETE; BEGIN IMMEDIATE")
    const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
    const tableNames = new Set(tables.map((table) => String(table.name)))
    const tableColumns = (table: string) =>
      db
        .prepare(`PRAGMA table_info(${quote(table)})`)
        .all()
        .map((row) => row.name)
    const columns = tableColumns("session")
    if (!["id", "metadata", "parent_id", "project_id"].every((column) => columns.includes(column))) {
      throw new Error(`Legacy session schema cannot be classified safely; full backup: ${snapshot}`)
    }
    db.exec(`CREATE TEMP TABLE omnia_sessions_v1 (id TEXT PRIMARY KEY NOT NULL);
      INSERT INTO omnia_sessions_v1 WITH RECURSIVE selected(id) AS (
        SELECT id FROM session WHERE id IS NOT NULL AND CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.mode') END IN ('work', 'code')
        UNION SELECT session.id FROM session JOIN selected ON session.parent_id = selected.id
      ) SELECT id FROM selected`)
    // Production databases keep both the legacy session table and its newer
    // session_v2 copy in the same identifier namespace. Classify each table on
    // its own lineage: a V2-native session has no V1 row to select it through.
    const hasSessionV2 = tableNames.has("session_v2")
    const v2Columns = hasSessionV2 ? tableColumns("session_v2") : []
    if (
      hasSessionV2 &&
      !["id", "metadata", "parent_id", "project_id"].every((column) => v2Columns.includes(column))
    ) {
      throw new Error(`Legacy session_v2 schema cannot be classified safely; full backup: ${snapshot}`)
    }
    if (hasSessionV2) {
      const v2Lineage = ["session_v2.parent_id = selected.id"]
      if (v2Columns.includes("fork_session_id")) v2Lineage.push("session_v2.fork_session_id = selected.id")
      const descendants = v2Lineage
        .map((edge) => `UNION SELECT session_v2.id FROM session_v2 JOIN selected ON ${edge}`)
        .join(" ")
      db.exec(`CREATE TEMP TABLE omnia_sessions_v2 (id TEXT PRIMARY KEY NOT NULL);
        INSERT INTO omnia_sessions_v2 WITH RECURSIVE selected(id) AS (
          SELECT id FROM session_v2 WHERE id IS NOT NULL AND CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.mode') END IN ('work', 'code')
          ${descendants}
        ) SELECT id FROM selected`)
    }
    db.exec(`CREATE TEMP TABLE omnia_sessions (id TEXT PRIMARY KEY NOT NULL);
      INSERT INTO omnia_sessions SELECT id FROM omnia_sessions_v1${
        hasSessionV2 ? " UNION SELECT id FROM omnia_sessions_v2" : ""
      }`)
    db.exec(`CREATE TEMP TABLE omnia_projects (id TEXT PRIMARY KEY NOT NULL);
      INSERT INTO omnia_projects SELECT project_id FROM session WHERE id IN (SELECT id FROM omnia_sessions_v1)${
        hasSessionV2
          ? " UNION SELECT project_id FROM session_v2 WHERE id IN (SELECT id FROM omnia_sessions_v2)"
          : ""
      }`)
    for (const table of tables) {
      const name = String(table.name)
      const fields = db
        .prepare(`PRAGMA table_info(${quote(name)})`)
        .all()
        .map((row) => row.name)
      // A v2 session record uses the same session identifier namespace. Keep it
      // when its own lineage was selected; dependent versioned rows are filtered below.
      if (name === "session_v2" && fields.includes("id")) {
        db.exec(`DELETE FROM ${quote(name)} WHERE id NOT IN (SELECT id FROM omnia_sessions_v2)`)
        continue
      }
      // These tables have no session, project, or workspace references: they are
      // caches/global state, not histories whose rows must be attributed.
      if (name === "kv" || name === "instruction_blob") continue
      if (["session", "project", "workspace", "migration", "__drizzle_migrations", "data_migration"].includes(name))
        continue
      if (fields.includes("session_id")) {
        db.exec(
          `DELETE FROM ${quote(name)} WHERE session_id IS NULL OR session_id NOT IN (SELECT id FROM omnia_sessions)`,
        )
        continue
      }
      if (["event", "event_sequence"].includes(name) && fields.includes("aggregate_id")) {
        db.exec(
          `DELETE FROM ${quote(name)} WHERE aggregate_id IS NULL OR aggregate_id NOT IN (SELECT id FROM omnia_sessions)`,
        )
        continue
      }
      if (fields.includes("project_id")) {
        db.exec(
          `DELETE FROM ${quote(name)} WHERE project_id IS NULL OR project_id NOT IN (SELECT id FROM omnia_projects)`,
        )
        continue
      }
      if (!["account", "account_state", "control_account", "credential"].includes(name)) {
        throw new Error(`Unrecognized legacy table ${name}; full backup: ${snapshot}`)
      }
      // Standalone CLI credentials/accounts are not Omnia session history.
      db.exec(`DELETE FROM ${quote(name)}`)
    }
    db.exec("DELETE FROM session WHERE id IS NULL OR id NOT IN (SELECT id FROM omnia_sessions_v1)")
    if (tables.some((table) => table.name === "workspace")) {
      const workspaceFields = tableColumns("workspace")
      if (columns.includes("workspace_id") && workspaceFields.includes("project_id")) {
        db.exec(
          "DELETE FROM workspace WHERE id NOT IN (SELECT workspace_id FROM session WHERE workspace_id IS NOT NULL)",
        )
      }
      // Newer workspace rows carry no project reference, so they cannot be
      // attributed to a session here. Preserve them rather than guessing.
    }
    if (tables.some((table) => table.name === "project")) {
      db.exec("DELETE FROM project WHERE id NOT IN (SELECT id FROM omnia_projects)")
    }
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error(`Migrated history has broken references; backup: ${snapshot}`)
    // Remove deleted records from free pages in the isolated copy as well.
    db.exec("COMMIT; VACUUM")
  } finally {
    db.close()
  }
  chmodSync(temporary, 0o600)
  // Exclusive publication: a second launch can never replace an existing DB.
  linkSync(temporary, destination)
  rmSync(temporary)
  return { backup: snapshot }
}
