import { afterEach, expect, test } from "bun:test"
import { DatabaseSync } from "node:sqlite"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Effect } from "effect"
import schema from "../../../core/src/database/schema.gen"
import { migrateOmniaStorage, omniaStorageEnv } from "./omnia-storage"

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function root() {
  const directory = mkdtempSync(join(tmpdir(), "omnia-storage-test-"))
  roots.push(directory)
  return directory
}

async function fixture(file: string) {
  const db = new DatabaseSync(file)
  await Effect.runPromise(
    schema.up({
      run: (sql: string) => Effect.sync(() => db.exec(sql)),
    } as unknown as Parameters<typeof schema.up>[0]),
  )
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
    INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES
      ('omnia-project', '/omnia', 1, 1, '[]'), ('cli-project', '/cli', 1, 1, '[]');`)
  const insert = db.prepare(`INSERT INTO session
    (id, project_id, parent_id, slug, directory, title, version, metadata, time_created, time_updated)
    VALUES (?, ?, ?, 'test', '/test', 'test', '1', ?, 1, 1)`)
  insert.run("work", "omnia-project", null, '{"mode":"work"}')
  insert.run("code", "omnia-project", null, '{"mode":"code"}')
  insert.run("child", "omnia-project", "work", null)
  insert.run("grandchild", "omnia-project", "child", null)
  insert.run("cli", "cli-project", null, null)
  insert.run("unknown", "omnia-project", null, '{"other":"desktop?"}')
  insert.run("malformed", "cli-project", null, "not json")
  for (const id of ["work", "child", "cli", "unknown"]) {
    db.prepare("INSERT INTO message VALUES (?, ?, 1, 1, '{}')").run(`message-${id}`, id)
    db.prepare("INSERT INTO part VALUES (?, ?, ?, 1, 1, '{}')").run(`part-${id}`, `message-${id}`, id)
    db.prepare("INSERT INTO session_message VALUES (?, ?, 'user', 1, 1, 1, '{}')").run(`v2-${id}`, id)
    db.prepare("INSERT INTO session_input VALUES (?, ?, '{}', 'steer', 2, NULL, 1)").run(`input-${id}`, id)
    db.prepare("INSERT INTO session_context_epoch VALUES (?, '{}', '{}', 1)").run(id)
    db.prepare("INSERT INTO event_sequence VALUES (?, 2, NULL)").run(id)
    db.prepare("INSERT INTO event VALUES (?, ?, 1, 'session.created', '{}')").run(`event-${id}`, id)
    db.prepare("INSERT INTO todo VALUES (?, 'task', 'pending', 'high', 0, 1, 1)").run(id)
  }
  db.exec(
    "INSERT INTO credential (id, label, value, time_created, time_updated) VALUES ('cli-only', 'fixture', 'fixture', 1, 1)",
  )
  db.exec(`CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO kv VALUES ('models-dev:catalog', '{}'), ('migration.v1-v2', '21');
    CREATE TABLE instruction_blob(hash TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO instruction_blob VALUES ('fixture-hash', 'fixture');
    CREATE TABLE session_v2(
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      parent_id TEXT,
      fork_session_id TEXT,
      metadata TEXT
    );
    INSERT INTO session_v2 VALUES
      ('work', 'omnia-project', NULL, NULL, '{"mode":"work"}'),
      ('cli', 'cli-project', NULL, NULL, NULL);`)
  return db
}

function productionFixture(file: string) {
  const db = new DatabaseSync(file)
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE project (id TEXT PRIMARY KEY);
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      parent_id TEXT,
      metadata TEXT
    );
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      parent_id TEXT,
      fork_session_id TEXT,
      metadata TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL
    );
    CREATE TABLE todo (
      session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
      content TEXT NOT NULL
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES session_v2(id) ON DELETE CASCADE
    );
    CREATE TABLE session_pending (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES session_v2(id) ON DELETE CASCADE
    );
    CREATE TABLE session_inbox (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES session_v2(id) ON DELETE CASCADE
    );
    CREATE TABLE instruction_entry (
      session_id TEXT PRIMARY KEY REFERENCES session_v2(id) ON DELETE CASCADE,
      value TEXT NOT NULL
    );
    CREATE TABLE instruction_state (
      session_id TEXT PRIMARY KEY REFERENCES session_v2(id) ON DELETE CASCADE,
      value TEXT NOT NULL
    );
    CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY);
    CREATE TABLE event (
      id TEXT PRIMARY KEY,
      aggregate_id TEXT NOT NULL REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE
    );
    CREATE TABLE permission (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE);
    CREATE TABLE worktree (
      project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      directory TEXT NOT NULL,
      PRIMARY KEY (project_id, directory)
    );
    CREATE TABLE project_directory (
      project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      directory TEXT NOT NULL,
      PRIMARY KEY (project_id, directory)
    );
    CREATE TABLE workspace (id TEXT PRIMARY KEY, provider TEXT, binding TEXT);
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE instruction_blob (hash TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE credential (id TEXT PRIMARY KEY);`)
  db.exec(`INSERT INTO project VALUES ('omnia-project'), ('cli-project');
    INSERT INTO session VALUES
      ('work', 'omnia-project', NULL, '{"mode":"work"}'),
      ('v1-child', 'omnia-project', 'work', NULL),
      ('cli', 'cli-project', NULL, NULL);
    INSERT INTO session_v2 VALUES
      ('work', 'omnia-project', NULL, NULL, '{"mode":"work"}'),
      ('v2-work', 'omnia-project', NULL, NULL, '{"mode":"work"}'),
      ('v2-child', 'omnia-project', 'v2-work', NULL, NULL),
      ('v2-fork', 'omnia-project', NULL, 'v2-work', NULL),
      ('v2-cli', 'cli-project', NULL, NULL, NULL);
    INSERT INTO message VALUES ('message-work', 'work'), ('message-cli', 'cli');
    INSERT INTO part VALUES ('part-work', 'message-work', 'work'), ('part-cli', 'message-cli', 'cli');
    INSERT INTO todo VALUES ('work', 'omnia task'), ('cli', 'cli task');
    INSERT INTO session_message VALUES
      ('v2-message-work', 'work'), ('v2-message-v2-work', 'v2-work'), ('v2-message-child', 'v2-child'),
      ('v2-message-fork', 'v2-fork'), ('v2-message-cli', 'v2-cli');
    INSERT INTO session_pending VALUES ('pending-work', 'v2-work'), ('pending-cli', 'v2-cli');
    INSERT INTO session_inbox VALUES ('inbox-work', 'v2-work'), ('inbox-cli', 'v2-cli');
    INSERT INTO instruction_entry VALUES ('v2-work', 'entry'), ('v2-cli', 'entry');
    INSERT INTO instruction_state VALUES ('v2-work', 'state'), ('v2-cli', 'state');
    INSERT INTO event_sequence VALUES ('work'), ('v2-work'), ('v2-cli');
    INSERT INTO event VALUES ('event-work', 'work'), ('event-v2-work', 'v2-work'), ('event-cli', 'v2-cli');
    INSERT INTO permission VALUES ('permission-omnia', 'omnia-project'), ('permission-cli', 'cli-project');
    INSERT INTO worktree VALUES ('omnia-project', '/omnia'), ('cli-project', '/cli');
    INSERT INTO project_directory VALUES ('omnia-project', '/omnia'), ('cli-project', '/cli');
    INSERT INTO workspace VALUES ('global-workspace', 'test-provider', 'test-binding');
    INSERT INTO kv VALUES ('models-dev:catalog', '{}');
    INSERT INTO instruction_blob VALUES ('fixture-hash', 'fixture');
    INSERT INTO credential VALUES ('cli-only')`)
  return db
}

test("backs up live WAL history and migrates only known Omnia sessions and descendants", async () => {
  const directory = root()
  const source = join(directory, "opencode.db")
  const destination = join(directory, "OMNIA.db")
  const original = await fixture(source)
  try {
    const before = readFileSync(source)
    const wal = readFileSync(source + "-wal")
    const result = await migrateOmniaStorage(destination, source)
    expect(readFileSync(source)).toEqual(before)
    expect(readFileSync(source + "-wal")).toEqual(wal)
    const migrated = new DatabaseSync(destination)
    const backup = new DatabaseSync(result!.backup, { readOnly: true })
    try {
      expect(
        migrated
          .prepare("SELECT id FROM session ORDER BY id")
          .all()
          .map((row) => row.id),
      ).toEqual(["child", "code", "grandchild", "work"])
      expect(backup.prepare("SELECT count(*) AS count FROM session").get()?.count).toBe(7)
      expect(original.prepare("SELECT count(*) AS count FROM session").get()?.count).toBe(7)
      for (const table of [
        "message",
        "part",
        "session_message",
        "session_input",
        "session_context_epoch",
        "event",
        "event_sequence",
        "todo",
      ]) {
        expect(migrated.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count).toBe(2)
      }
      expect(
        migrated
          .prepare("SELECT id FROM project")
          .all()
          .map((row) => row.id),
      ).toEqual(["omnia-project"])
      expect(migrated.prepare("SELECT count(*) AS count FROM credential").get()?.count).toBe(0)
      // Global caches are not session history, so they survive filtering intact.
      expect(migrated.prepare("SELECT count(*) AS count FROM kv").get()?.count).toBe(2)
      expect(migrated.prepare("SELECT count(*) AS count FROM instruction_blob").get()?.count).toBe(1)
      // A session-generation record shares the same selection key as its history.
      expect(migrated.prepare("SELECT id FROM session_v2 ORDER BY id").all().map((row) => row.id)).toEqual(["work"])
      expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([])
      migrated
        .prepare(
          `INSERT INTO session
        (id, project_id, slug, directory, title, version, metadata, time_created, time_updated)
        VALUES ('new-omnia', 'omnia-project', 'test', '/test', 'test', '1', '{"mode":"work"}', 1, 1)`,
        )
        .run()
      expect(original.prepare("SELECT id FROM session WHERE id = 'new-omnia'").get()).toBeUndefined()
      expect(await migrateOmniaStorage(destination, source)).toBeUndefined()
      expect(migrated.prepare("SELECT id FROM session WHERE id = 'new-omnia'").get()?.id).toBe("new-omnia")
      expect(statSync(destination).mode & 0o777).toBe(0o600)
      expect(statSync(result!.backup).mode & 0o777).toBe(0o600)
      expect(readFileSync(join(result!.backup, "..", "RECOVERY.txt"), "utf8")).toContain("unclassified")
    } finally {
      migrated.close()
      backup.close()
    }
  } finally {
    original.close()
  }
})

test("production V2 lineage keeps V2-native sessions and their dependents", async () => {
  const directory = root()
  const source = join(directory, "opencode.db")
  const destination = join(directory, "OMNIA.db")
  const original = productionFixture(source)
  try {
    const result = await migrateOmniaStorage(destination, source)
    const migrated = new DatabaseSync(destination)
    const backup = new DatabaseSync(result!.backup, { readOnly: true })
    try {
      expect(
        migrated
          .prepare("SELECT id FROM session ORDER BY id")
          .all()
          .map((row) => row.id),
      ).toEqual(["v1-child", "work"])
      expect(
        migrated
          .prepare("SELECT id FROM session_v2 ORDER BY id")
          .all()
          .map((row) => row.id),
      ).toEqual(["v2-child", "v2-fork", "v2-work", "work"])
      expect(migrated.prepare("SELECT count(*) AS count FROM session_message").get()?.count).toBe(4)
      for (const table of ["session_pending", "session_inbox", "instruction_entry", "instruction_state"]) {
        expect(migrated.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count).toBe(1)
      }
      for (const table of ["message", "part", "todo"]) {
        expect(migrated.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count).toBe(1)
      }
      for (const table of ["event", "event_sequence"]) {
        expect(migrated.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count).toBe(2)
      }
      expect(
        migrated
          .prepare("SELECT id FROM project")
          .all()
          .map((row) => row.id),
      ).toEqual(["omnia-project"])
      for (const table of ["permission", "worktree", "project_directory"]) {
        expect(migrated.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count).toBe(1)
      }
      // A project-detached workspace cannot be attributed to a session here, so
      // it is preserved rather than classified as CLI history.
      expect(migrated.prepare("SELECT count(*) AS count FROM workspace").get()?.count).toBe(1)
      expect(migrated.prepare("SELECT count(*) AS count FROM kv").get()?.count).toBe(1)
      expect(migrated.prepare("SELECT count(*) AS count FROM instruction_blob").get()?.count).toBe(1)
      expect(migrated.prepare("SELECT count(*) AS count FROM credential").get()?.count).toBe(0)
      expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([])
      expect(backup.prepare("SELECT count(*) AS count FROM session_v2").get()?.count).toBe(5)
      expect(original.prepare("SELECT count(*) AS count FROM session_v2").get()?.count).toBe(5)
    } finally {
      migrated.close()
      backup.close()
    }
  } finally {
    original.close()
  }
})

test("unknown schemas block publication without modifying original history", async () => {
  const directory = root()
  const source = join(directory, "opencode.db")
  const destination = join(directory, "OMNIA.db")
  const db = await fixture(source)
  db.exec("CREATE TABLE future_history (data TEXT); INSERT INTO future_history VALUES ('keep')")
  try {
    await expect(migrateOmniaStorage(destination, source)).rejects.toThrow("Unrecognized legacy table future_history")
    expect(existsSync(destination)).toBe(false)
    expect(db.prepare("SELECT data FROM future_history").get()?.data).toBe("keep")
    expect(db.prepare("SELECT count(*) AS count FROM session").get()?.count).toBe(7)
    const backups = join(directory, "migration-backups")
    const snapshot = join(backups, readdirSync(backups)[0], "opencode-original.db")
    const full = new DatabaseSync(snapshot, { readOnly: true })
    try {
      expect(full.prepare("SELECT data FROM future_history").get()?.data).toBe("keep")
      expect(readFileSync(join(snapshot, "..", "RECOVERY.txt"), "utf8")).toContain("unclassified")
    } finally {
      full.close()
    }
  } finally {
    db.close()
  }
})

test("refuses a symlink destination and overrides shell-exported app storage paths", async () => {
  const directory = root()
  const target = join(directory, "target.db")
  const db = new DatabaseSync(target)
  db.close()
  const destination = join(directory, "OMNIA.db")
  symlinkSync(target, destination)
  await expect(migrateOmniaStorage(destination)).rejects.toThrow("symlink")
  const env = omniaStorageEnv(directory, { OPENCODE_DB: "/old/opencode.db", XDG_STATE_HOME: "/shared/state" })
  expect(env.OPENCODE_DB).toBe(destination)
  expect(env.OMNIA_CONFIG_FILE).toBe(join(directory, "config", "OMNIA.json"))
  expect(env.XDG_STATE_HOME).toBe(join(directory, "state"))
  expect(env.OMNIA_LEGACY_DB).toBe("/old/opencode.db")
  expect(omniaStorageEnv(directory, { ...env })).toEqual(env)
})

test("production source takes precedence over development databases", () => {
  const directory = root()
  const data = join(directory, "data", "opencode")
  mkdirSync(data, { recursive: true })
  for (const name of ["opencode.db", "opencode-local.db"]) new DatabaseSync(join(data, name)).close()
  expect(omniaStorageEnv(directory, { XDG_DATA_HOME: join(directory, "data") }).OMNIA_LEGACY_DB).toBe(join(data, "opencode.db"))
  expect(
    omniaStorageEnv(directory, { XDG_DATA_HOME: join(directory, "data"), OPENCODE_DB: "opencode-local.db" })
      .OMNIA_LEGACY_DB,
  ).toBe(join(data, "opencode-local.db"))
})

test("multiple development databases without a production source require an explicit source", () => {
  const directory = root()
  const data = join(directory, "data", "opencode")
  mkdirSync(data, { recursive: true })
  for (const name of ["opencode-dev.db", "opencode-local.db"]) new DatabaseSync(join(data, name)).close()
  expect(() => omniaStorageEnv(directory, { XDG_DATA_HOME: join(directory, "data") })).toThrow("Multiple legacy")
})

test("Node sidecar SQLite backup API migrates live WAL records", async () => {
  const directory = root()
  const source = join(directory, "opencode.db")
  const destination = join(directory, "OMNIA.db")
  const db = await fixture(source)
  try {
    const before = readFileSync(source)
    const wal = readFileSync(source + "-wal")
    const child = Bun.spawn(
      [
        "node",
        "-e",
        `
      const { migrateOmniaStorage } = await import(${JSON.stringify(new URL("./omnia-storage.ts", import.meta.url).href)});
      await migrateOmniaStorage(${JSON.stringify(destination)}, ${JSON.stringify(source)});
    `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const stderr = await new Response(child.stderr).text()
    expect(await child.exited, stderr).toBe(0)
    expect(readFileSync(source)).toEqual(before)
    expect(readFileSync(source + "-wal")).toEqual(wal)
    const migrated = new DatabaseSync(destination, { readOnly: true })
    try {
      expect(migrated.prepare("SELECT count(*) AS count FROM session").get()?.count).toBe(4)
    } finally {
      migrated.close()
    }
  } finally {
    db.close()
  }
})

test("core runtime resolves the isolated absolute DB before imports", async () => {
  const directory = root()
  const env = omniaStorageEnv(directory, { OPENCODE_DB: join(directory, "standalone.db") })
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    const { Database } = await import(${JSON.stringify(new URL("../../../core/src/database/database.ts", import.meta.url).href)});
    if (Database.path() !== process.env.OPENCODE_DB) throw new Error('wrong database');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(Database.path());
    db.exec("CREATE TABLE session (id TEXT); INSERT INTO session VALUES ('new-omnia')");
    db.close();
  `,
    ],
    { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" },
  )
  const stderr = await new Response(child.stderr).text()
  expect(await child.exited, stderr).toBe(0)
  expect(existsSync(env.OPENCODE_DB)).toBe(true)
  expect(existsSync(env.OMNIA_LEGACY_DB)).toBe(false)
  const standalone: NodeJS.ProcessEnv = { ...process.env, ...env, OPENCODE_DISABLE_CHANNEL_DB: "true" }
  delete standalone.OPENCODE_DB
  delete standalone.OMNIA_CONFIG_FILE
  const cli = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    const { Database } = await import(${JSON.stringify(new URL("../../../core/src/database/database.ts", import.meta.url).href)});
    if (Database.path() !== ${JSON.stringify(join(env.XDG_DATA_HOME, "opencode", "opencode.db"))}) throw new Error('CLI defaults changed');
  `,
    ],
    { env: standalone, stdout: "pipe", stderr: "pipe" },
  )
  const cliError = await new Response(cli.stderr).text()
  expect(await cli.exited, cliError).toBe(0)
})
