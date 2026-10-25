#!/usr/bin/env bun
/**
 * Operator tool for Terms of Service bans. It enforces a ban on this computer
 * (fuse markers plus an encrypted session database) or lifts one.
 *
 * Bans for other computers are published at the endpoint the app checks
 * (`OMNIA_BAN_URL`, or `<control plane>/v1/legal/status`). That endpoint may
 * answer for one fingerprint or serve a list:
 *   { "bans": [{ "fingerprint": "<id>", "reason": "..." }] }
 * which is why a static JSON file is enough.
 *
 * Usage:
 *   bun packages/desktop/script/legal.ts status [--user-data <dir>]
 *   bun packages/desktop/script/legal.ts ban --reason "..." [--user-data <dir>]
 *   bun packages/desktop/script/legal.ts unban [--user-data <dir>]
 *   bun packages/desktop/script/legal.ts smoke [--source <OMNIA.db>] [--keep]
 *
 * `smoke` runs the whole lifecycle against a throwaway fingerprint, a temporary
 * fuse and a local ban endpoint, so it can never ban this computer or touch its
 * session database. It copies a real database (the dev install by default) and
 * proves the sessions come back intact after an unban.
 */
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { createLegalController, fusePaths, TERMS_VERSION } from "../src/main/legal"

const argv = process.argv.slice(2)
const command = argv[0]
const flag = (name: string) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}
const userData =
  flag("--user-data") ??
  join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "io.omnia.desktop.dev")

// This process never renders, so it must not touch the Electron settings store.
const acceptance = {
  read: async () => undefined,
  write: async () => undefined,
}

const operator = (data: string) =>
  createLegalController({
    userDataPath: data,
    acceptance,
    log: (message, meta) => console.error(`[legal] ${message}`, meta ?? ""),
  })

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2))
const reason = flag("--reason")

if (command === "status") {
  print({ userData, fusePaths: fusePaths(), status: await operator(userData).status() })
} else if (command === "ban") {
  if (reason === undefined || reason.trim().length === 0) {
    console.error('usage: legal.ts ban --reason "reason shown to the user" [--user-data <dir>]')
    process.exit(2)
  }
  print(await operator(userData).ban(reason.trim()))
} else if (command === "unban") {
  print(await operator(userData).unban())
} else if (command === "smoke") {
  print(await runSmoke({ source: flag("--source"), keep: argv.includes("--keep") }))
} else {
  console.error(
    "usage: legal.ts <status|ban|unban|smoke> [--reason <text>] [--user-data <dir>] [--source <db>] [--keep]",
  )
  process.exit(2)
}

/**
 * The ban lifecycle on disposable data. Everything that could affect a real
 * installation (fingerprint, fuse location, ban endpoint, database) is either
 * overridden or lives under a temp directory.
 */
async function runSmoke(options: { source?: string; keep: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "omnia-legal-smoke-"))
  const fuse = join(root, "fuse.json")
  const fingerprint = "smoke-account-0000000000000000"
  const account = "smoke-account@example.test"
  const first = join(root, "install-a")
  const second = join(root, "install-b")
  const third = join(root, "install-c")
  const checks: string[] = []
  const check = (name: string, ok: boolean) => {
    if (!ok) throw new Error(`smoke failed: ${name}`)
    checks.push(name)
  }

  let bans: { fingerprint?: string; email?: string; reason: string }[] = []
  const endpoint = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.json({ bans }),
  })
  const banUrl = `http://127.0.0.1:${endpoint.port}/v1/legal/status`
  const install = (data: string, url = banUrl) =>
    createLegalController({
      userDataPath: data,
      acceptance,
      fusePaths: [fuse],
      fingerprint,
      banUrl: url,
      account: () => account,
      log: () => undefined,
    })

  try {
    const source = options.source ?? defaultDatabase()
    installDatabase(first, source)
    installDatabase(third, source)
    mkdirSync(second, { recursive: true })
    const before = snapshot(first)
    check("the copy holds real sessions", before.sessions > 0 && before.messages > 0)

    const clean = await install(first).startup()
    check("a clean install starts unbanned", clean.banned === false)
    check("its sessions are readable", existsSync(join(first, "OMNIA.db")))

    bans = [{ fingerprint, reason: "test" }]
    const banned = await install(first).startup()
    check("a published ban is enforced", banned.banned === true)
    check("the ban reports its source and reason", banned.source === "remote" && banned.reason === "test")
    check("the session database is sealed", banned.sealed === true)
    check("the plaintext database is removed", !existsSync(join(first, "OMNIA.db")))
    check("the sealed container stays on disk", existsSync(join(first, "OMNIA.db.sealed")))

    const sealed = readFileSync(join(first, "OMNIA.db.sealed"))
    check("the sealed container is not a readable SQLite file", !sealed.includes(Buffer.from("SQLite format 3")))
    check("session titles do not leak into the sealed file", !sealed.includes(Buffer.from(before.title)))

    const reinstalled = await install(second).startup()
    check("a fresh data folder is still banned", reinstalled.banned === true)
    const refused = await install(second)
      .accept(TERMS_VERSION)
      .then(() => false)
      .catch(() => true)
    check("a banned installation cannot accept the terms", refused)

    const offline = await install(second, "http://127.0.0.1:9/").refresh()
    check("an unreachable operator cannot lift a ban", offline.status.banned === true && offline.restored === false)

    bans = []
    const lifted = await install(first).refresh()
    check("an explicit not-banned answer lifts the ban", lifted.status.banned === false && lifted.restored === true)
    check("the database is decrypted back into place", existsSync(join(first, "OMNIA.db")))
    check("no sealed copy is left behind", !existsSync(join(first, "OMNIA.db.sealed")))

    const after = snapshot(first)
    check(
      "every session and message survives the round trip",
      after.sessions === before.sessions && after.messages === before.messages && after.title === before.title,
    )
    check("the restored database is byte-identical", after.bytes === before.bytes)

    // An account ban is the same lifecycle with an email as the subject: the
    // fingerprint here was never banned, so only the account can be the reason.
    bans = [{ email: account, reason: "test account" }]
    const accountBanned = await install(third).startup()
    check("an account ban blocks a clean installation", accountBanned.banned === true && accountBanned.source === "remote")
    check("the account ban shows its reason", accountBanned.reason === "test account")
    check("the account ban seals the sessions", accountBanned.sealed === true && !existsSync(join(third, "OMNIA.db")))

    bans = []
    const accountLifted = await install(third).refresh()
    check("lifting the account ban decrypts the sessions", accountLifted.status.banned === false && accountLifted.restored)
    const thirdSnapshot = snapshot(third)
    check(
      "the account round trip keeps every session",
      thirdSnapshot.sessions === before.sessions && thirdSnapshot.messages === before.messages && thirdSnapshot.bytes === before.bytes,
    )

    return {
      ok: true,
      source,
      fingerprint,
      account,
      banUrl,
      sessions: thirdSnapshot.sessions,
      messages: thirdSnapshot.messages,
      checks,
    }
  } finally {
    endpoint.stop(true)
    if (!options.keep) rmSync(root, { recursive: true, force: true })
    else console.error(`[legal] smoke data kept at ${root}`)
  }
}

function defaultDatabase() {
  const candidate = join(join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "io.omnia.desktop.dev"), "OMNIA.db")
  if (!existsSync(candidate)) throw new Error("no source database; pass --source <OMNIA.db>")
  return candidate
}

// Copies the database with its WAL, then checkpoints the copy so the baseline
// hash describes one standalone file. The live database is only read.
function installDatabase(directory: string, source: string) {
  mkdirSync(directory, { recursive: true })
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(`${source}${suffix}`)) cpSync(`${source}${suffix}`, join(directory, `OMNIA.db${suffix}`))
  }
  const db = new DatabaseSync(join(directory, "OMNIA.db"))
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  } finally {
    db.close()
  }
}

function snapshot(directory: string) {
  const database = join(directory, "OMNIA.db")
  const db = new DatabaseSync(database)
  const sessions = db.prepare("select count(*) as n from session").get() as { n: number }
  const messages = db.prepare("select count(*) as n from message").get() as { n: number }
  const first = db.prepare("select title from session order by time_created, id limit 1").get() as
    | { title: string }
    | undefined
  db.close()
  return {
    sessions: sessions.n,
    messages: messages.n,
    title: first?.title ?? "",
    bytes: createHash("sha256").update(readFileSync(database)).digest("hex"),
  }
}
