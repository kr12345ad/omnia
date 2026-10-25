// The public ban check the desktop reads before it starts its server.
//
// This route is deliberately reachable without a bearer: a blocked installation
// has to learn it is blocked at startup, and a banned account has already had
// its local credentials removed. The tests pin both halves of that contract -
// the answer names a ban by account or by fingerprint, and it never leaks
// anything about an account that is not banned.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openEnterpriseStore } from "../enterprise/store"
import { startOmniaServer } from "./server"

type Server = Awaited<ReturnType<typeof startOmniaServer>>

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function directory() {
  const created = mkdtempSync(join(tmpdir(), "omnia-legal-status-"))
  directories.push(created)
  return created
}

async function withServer<T>(
  input: { enterprise: boolean },
  fn: (server: Server, storeFile: string) => Promise<T>,
): Promise<T> {
  const dir = directory()
  const storeFile = join(dir, "enterprise.json")
  const server = await startOmniaServer({
    token: "operator-token",
    authFile: join(dir, "auth.json"),
    ...(input.enterprise ? { enterprise: { file: storeFile, publicUrl: "", mode: "lan" as const } } : {}),
  })
  try {
    return await fn(server, storeFile)
  } finally {
    await server.stop()
  }
}

function check(server: Server, query: string) {
  // No Authorization header: this is the request a blocked client makes.
  return fetch(`${server.url}/v1/legal/status?${query}`)
}

async function answer(response: Response) {
  return (await response.json()) as { ok: boolean; banned: boolean; reason?: string; bannedAt?: number }
}

describe("public legal status", () => {
  test("an account ban is answered for every installation signed into it", async () => {
    await withServer({ enterprise: true }, async (server) => {
      const store = server.enterprise!.store
      const ban = store.banLegalSubject({
        kind: "account",
        value: "Banned@Example.com",
        reason: "test",
        createdBy: "test",
      })

      const blocked = await check(server, "email=banned@example.com&fingerprint=cleanmachine01")
      expect(blocked.status).toBe(200)
      expect(await answer(blocked)).toEqual({
        ok: true,
        banned: true,
        reason: "test",
        bannedAt: ban.bannedAt,
      })

      // The same machine under another account stays usable, which is what
      // makes the ban an account ban rather than a device ban.
      expect(await answer(await check(server, "email=other@example.com&fingerprint=cleanmachine01"))).toEqual({
        ok: true,
        banned: false,
      })
      // Case does not matter, and a malformed address matches no record.
      expect((await answer(await check(server, "email=BANNED@example.com"))).banned).toBe(true)
      expect((await answer(await check(server, "email=not-an-email"))).banned).toBe(false)
    })
  })

  test("an installation ban is answered for its fingerprint alone", async () => {
    await withServer({ enterprise: true }, async (server) => {
      server.enterprise!.store.banLegalSubject({
        kind: "installation",
        value: "8B971E7A7450184D6EC77C39361B3C48",
        reason: "device",
        createdBy: "test",
      })
      const blocked = await check(server, "fingerprint=8b971e7a7450184d6ec77c39361b3c48")
      expect(await answer(blocked)).toMatchObject({ banned: true, reason: "device" })
      expect((await answer(await check(server, "fingerprint=0000000000000000"))).banned).toBe(false)
      expect((await answer(await check(server, "fingerprint=zzz"))).banned).toBe(false)
    })
  })

  test("a lifted ban stops blocking and keeps the record", async () => {
    await withServer({ enterprise: true }, async (server) => {
      const store = server.enterprise!.store
      store.banLegalSubject({ kind: "account", value: "a@example.com", reason: "test", createdBy: "test" })
      expect((await answer(await check(server, "email=a@example.com"))).banned).toBe(true)
      store.liftLegalBan({ kind: "account", value: "a@example.com", liftedBy: "test" })
      expect(await answer(await check(server, "email=a@example.com"))).toEqual({ ok: true, banned: false })
      expect(store.legalBans()).toHaveLength(1)
    })
  })

  test("a ban written by another process reaches the running server", async () => {
    await withServer({ enterprise: true }, async (server, storeFile) => {
      // The operator CLI is a second process against the same file: the running
      // server must notice without a restart, or an unban would appear to do
      // nothing until someone restarted the control plane.
      const cli = openEnterpriseStore({ file: storeFile })
      cli.banLegalSubject({ kind: "account", value: "late@example.com", reason: "applied live", createdBy: "cli" })
      expect(await answer(await check(server, "email=late@example.com"))).toMatchObject({
        banned: true,
        reason: "applied live",
      })

      cli.liftLegalBan({ kind: "account", value: "late@example.com", liftedBy: "cli" })
      expect(await answer(await check(server, "email=late@example.com"))).toEqual({ ok: true, banned: false })
      expect(server.enterprise!.store.legalBans()[0]?.liftedBy).toBe("cli")
    })
  })

  test("a computer-only server answers not banned", async () => {
    await withServer({ enterprise: false }, async (server) => {
      expect(await answer(await check(server, "email=banned@example.com"))).toEqual({ ok: true, banned: false })
    })
  })
})
