import { afterEach, describe, expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  computeFingerprint,
  createLegalController,
  fusePaths,
  hasSealedSessions,
  parseBanResponse,
  readFuse,
  sealKey,
  sealSessions,
  TERMS_VERSION,
  unsealSessions,
  writeFuse,
  type Acceptance,
} from "./legal"

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "omnia-legal-test-"))
  roots.push(directory)
  return directory
}

function acceptanceStore(initial?: Acceptance) {
  let value = initial
  return {
    read: async () => value,
    write: async (next: Acceptance) => {
      value = next
    },
    current: () => value,
  }
}

const remote = (body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch

describe("fingerprint", () => {
  test("is stable for one machine and differs across machines", () => {
    const one = computeFingerprint({ machineId: "machine-a", host: "laptop", user: "sam" })
    expect(computeFingerprint({ machineId: "machine-a", host: "laptop", user: "sam" })).toBe(one)
    expect(computeFingerprint({ machineId: "machine-b", host: "laptop", user: "sam" })).not.toBe(one)
    expect(one).toHaveLength(32)
  })
})

describe("ban fuse", () => {
  test("a ban survives a reinstall because it lives outside the app data folder", async () => {
    const directory = root()
    const fuse = [join(directory, "fuse", "fuse.json")]
    const userData = join(directory, "first-install")
    mkdirSync(userData, { recursive: true })
    writeFileSync(join(userData, "OMNIA.db"), randomBytes(2048))

    const first = createLegalController({
      userDataPath: userData,
      fusePaths: fuse,
      acceptance: acceptanceStore(),
      fetch: remote({ banned: false }),
    })
    const banned = await first.ban("Testing the fuse")
    expect(banned.banned).toBe(true)
    expect(banned.sealed).toBe(true)
    expect(existsSync(join(userData, "OMNIA.db"))).toBe(false)

    // Uninstalling the app removes its data directory only; the fuse is elsewhere.
    rmSync(userData, { recursive: true, force: true })
    const reinstall = join(directory, "second-install")
    mkdirSync(reinstall, { recursive: true })
    writeFileSync(join(reinstall, "OMNIA.db"), randomBytes(2048))

    const second = createLegalController({
      userDataPath: reinstall,
      fusePaths: fuse,
      acceptance: acceptanceStore(),
      fetch: remote({ banned: false }),
    })
    const status = await second.startup()
    expect(status.banned).toBe(true)
    expect(status.reason).toBe("Testing the fuse")
    expect(status.sealed).toBe(true)
    expect(existsSync(join(reinstall, "OMNIA.db"))).toBe(false)
  })

  test("one surviving marker keeps the ban, and the newest record supplies the key", () => {
    const directory = root()
    const paths = [join(directory, "a.json"), join(directory, "b.json")]
    const oldKey = randomBytes(32).toString("base64")
    const newKey = randomBytes(32).toString("base64")
    writeFuse([paths[0]], {
      version: 1,
      fingerprint: "fp",
      key: oldKey,
      banned: false,
      updatedAt: 1,
    })
    writeFuse([paths[0]], {
      version: 1,
      fingerprint: "fp",
      key: newKey,
      banned: false,
      updatedAt: 3,
    })
    writeFuse([paths[1]], {
      version: 1,
      fingerprint: "fp",
      key: oldKey,
      banned: true,
      reason: "kept",
      updatedAt: 2,
    })
    const record = readFuse(paths)
    expect(record?.banned).toBe(true)
    expect(record?.reason).toBe("kept")
    // A banned marker wins even though a newer record exists.
    expect(record?.key).toBe(oldKey)
    rmSync(paths[1])
    expect(readFuse(paths)?.key).toBe(newKey)
  })

  test("fuse paths are outside the application data directory", () => {
    const paths = fusePaths({ XDG_CONFIG_HOME: "/tmp/xdg-config", XDG_DATA_HOME: "/tmp/xdg-data" })
    expect(paths.some((path) => path.endsWith("/tmp/xdg-config/omnia/legal/fuse.json"))).toBe(true)
    expect(paths.some((path) => path.endsWith("/tmp/xdg-data/omnia/legal/fuse.json"))).toBe(true)
  })
})

describe("session sealing", () => {
  test("restores the exact bytes of a sealed database", async () => {
    const directory = root()
    const userData = join(directory, "user")
    mkdirSync(userData, { recursive: true })
    const contents = randomBytes(256 * 1024)
    writeFileSync(join(userData, "OMNIA.db"), contents)
    const key = randomBytes(32)

    expect(await sealSessions(userData, key)).toBe(true)
    expect(existsSync(join(userData, "OMNIA.db"))).toBe(false)
    expect(hasSealedSessions(userData)).toBe(true)

    expect(await unsealSessions(userData, key)).toBe(true)
    expect(hasSealedSessions(userData)).toBe(false)
    expect(
      createHash("sha256").update(readFileSync(join(userData, "OMNIA.db"))).digest("hex"),
    ).toBe(createHash("sha256").update(contents).digest("hex"))
  })

  test("refuses a wrong key instead of publishing damaged data", async () => {
    const directory = root()
    const userData = join(directory, "user")
    mkdirSync(userData, { recursive: true })
    writeFileSync(join(userData, "OMNIA.db"), randomBytes(4096))

    const key = randomBytes(32)
    await sealSessions(userData, key)
    expect(unsealSessions(userData, randomBytes(32))).rejects.toThrow("different key")
    expect(existsSync(join(userData, "OMNIA.db"))).toBe(false)
    expect(hasSealedSessions(userData)).toBe(true)
  })

  test("seals and restores a key handed back by the fuse", () => {
    const key = randomBytes(32)
    expect(sealKey({ version: 1, fingerprint: "fp", key: key.toString("base64"), banned: true, updatedAt: 1 })).toEqual(key)
    expect(sealKey(undefined)).toHaveLength(32)
  })
})

describe("legal controller", () => {
  const setup = () => {
    const directory = root()
    const userData = join(directory, "user")
    const fuse = [join(directory, "fuse", "fuse.json")]
    mkdirSync(userData, { recursive: true })
    writeFileSync(join(userData, "OMNIA.db"), randomBytes(8192))
    return { directory, userData, fuse }
  }

  test("a remote ban at startup seals sessions before the server can start", async () => {
    const { userData, fuse } = setup()
    let stopped = false
    const legal = createLegalController({
      userDataPath: userData,
      fusePaths: fuse,
      acceptance: acceptanceStore({ version: TERMS_VERSION, acceptedAt: 1 }),
      banUrl: "https://operator.test/v1/legal/status",
      beforeSeal: async () => {
        stopped = true
      },
      fetch: remote({ banned: true, reason: "Terms breach", bannedAt: 1700000000000 }),
    })
    const status = await legal.startup()
    expect(status.banned).toBe(true)
    expect(status.source).toBe("remote")
    expect(status.reason).toBe("Terms breach")
    expect(status.sealed).toBe(true)
    expect(stopped).toBe(true)
    expect(existsSync(join(userData, "OMNIA.db"))).toBe(false)
  })

  test("an accepted ban is lifted only by an explicit not-banned answer", async () => {
    const { directory, userData, fuse } = setup()
    const acceptance = acceptanceStore({ version: TERMS_VERSION, acceptedAt: 1 })
    const banned = createLegalController({
      userDataPath: userData,
      fusePaths: fuse,
      acceptance,
      banUrl: "https://operator.test/v1/legal/status",
      fetch: remote({ banned: true, reason: "Appeal pending" }),
    })
    await banned.startup()

    const unreachable = createLegalController({
      userDataPath: userData,
      fusePaths: fuse,
      acceptance,
      banUrl: "https://operator.test/v1/legal/status",
      fetch: (async () => {
        throw new Error("offline")
      }) as unknown as typeof fetch,
    })
    const kept = await unreachable.refresh()
    expect(kept.status.banned).toBe(true)
    expect(kept.restored).toBe(false)
    expect(hasSealedSessions(userData)).toBe(true)

    const lifted = createLegalController({
      userDataPath: userData,
      fusePaths: fuse,
      acceptance,
      banUrl: "https://operator.test/v1/legal/status",
      fetch: remote({ bans: [] }),
    })
    const result = await lifted.refresh()
    expect(result.restored).toBe(true)
    expect(result.status.banned).toBe(false)
    expect(existsSync(join(userData, "OMNIA.db"))).toBe(true)
    expect(hasSealedSessions(userData)).toBe(false)
    expect(existsSync(join(directory, "fuse", "fuse.json"))).toBe(false)
  })

  test("an account ban blocks a clean machine whose owner is signed in", async () => {
    const { userData, fuse } = setup()
    const requests: URL[] = []
    const legal = createLegalController({
      userDataPath: userData,
      fusePaths: fuse,
      acceptance: acceptanceStore({ version: TERMS_VERSION, acceptedAt: 1 }),
      banUrl: "https://operator.test/v1/legal/status",
      // The account is what the operator banned; this fingerprint is clean.
      account: () => "Banned@Example.com",
      fetch: (async (url: URL) => {
        requests.push(url)
        return new Response(
          JSON.stringify({ bans: [{ email: "banned@example.com", reason: "Account ban" }] }),
          { status: 200 },
        )
      }) as unknown as typeof fetch,
    })

    const status = await legal.startup()
    expect(requests[0]?.searchParams.get("email")).toBe("Banned@Example.com")
    expect(requests[0]?.searchParams.get("fingerprint")).toHaveLength(32)
    expect(status.banned).toBe(true)
    expect(status.source).toBe("remote")
    expect(status.reason).toBe("Account ban")
    expect(hasSealedSessions(userData)).toBe(true)
    expect(existsSync(join(userData, "OMNIA.db"))).toBe(false)
  })

  test("an account ban lifted by the operator decrypts the sessions again", async () => {
    const { userData, fuse } = setup()
    const acceptance = acceptanceStore({ version: TERMS_VERSION, acceptedAt: 1 })
    const banned = createLegalController({
      userDataPath: userData,
      fusePaths: fuse,
      acceptance,
      banUrl: "https://operator.test/v1/legal/status",
      account: () => "banned@example.com",
      fetch: remote({ bans: [{ email: "banned@example.com", reason: "test" }] }),
    })
    await banned.startup()
    expect(hasSealedSessions(userData)).toBe(true)

    const lifted = createLegalController({
      userDataPath: userData,
      fusePaths: fuse,
      acceptance,
      banUrl: "https://operator.test/v1/legal/status",
      account: () => "banned@example.com",
      fetch: remote({ bans: [] }),
    })
    const result = await lifted.refresh()
    expect(result.status.banned).toBe(false)
    expect(result.restored).toBe(true)

    // The same signed-in account is unblocked only because the operator said so.
    const stillSignedIn = createLegalController({
      userDataPath: userData,
      fusePaths: fuse,
      acceptance,
      banUrl: "https://operator.test/v1/legal/status",
      account: () => "banned@example.com",
      fetch: remote({ bans: [] }),
    })
    expect((await stillSignedIn.status()).banned).toBe(false)
  })

  test("existing installations start unaccepted and accept only the current version", async () => {
    const { userData, fuse } = setup()
    const acceptance = acceptanceStore()
    const legal = createLegalController({
      userDataPath: userData,
      fusePaths: fuse,
      acceptance,
      fetch: remote({ banned: false }),
    })
    const before = await legal.status()
    expect(before.accepted).toBe(false)
    expect(before.acceptedVersion).toBe(null)

    expect(legal.accept("1999-01-01")).rejects.toThrow("version mismatch")
    const accepted = await legal.accept(TERMS_VERSION)
    expect(accepted.accepted).toBe(true)
    expect(accepted.acceptedAt).not.toBe(null)
    expect(acceptance.current()?.version).toBe(TERMS_VERSION)
  })

  test("a banned installation cannot accept the terms", async () => {
    const { userData, fuse } = setup()
    const legal = createLegalController({
      userDataPath: userData,
      fusePaths: fuse,
      acceptance: acceptanceStore(),
      banUrl: "https://operator.test/v1/legal/status",
      fetch: remote({ banned: true, reason: "Breach" }),
    })
    await legal.startup()
    expect(legal.accept(TERMS_VERSION)).rejects.toThrow("banned")
  })
})

describe("ban endpoint payloads", () => {
  test("accepts a direct answer, a list, and a keyed map", () => {
    expect(parseBanResponse({ banned: true, reason: "direct" }, "fp")).toEqual({ banned: true, reason: "direct", bannedAt: undefined })
    expect(parseBanResponse({ bans: [{ fingerprint: "fp", reason: "list", bannedAt: 5 }] }, "fp")).toEqual({
      banned: true,
      reason: "list",
      bannedAt: 5,
    })
    expect(parseBanResponse({ bans: { fp: { reason: "map" } } }, "fp")).toEqual({
      banned: true,
      reason: "map",
      bannedAt: undefined,
    })
    expect(parseBanResponse({ bans: [{ fingerprint: "other" }] }, "fp")).toEqual({ banned: false })
    expect(parseBanResponse({ nope: true }, "fp")).toBeUndefined()
  })
})

describe("terms version", () => {
  test("matches the version shipped in the renderer", () => {
    const source = readFileSync(join(import.meta.dir, "../../../app/src/legal/terms.ts"), "utf8")
    const version = /export const TERMS_VERSION = "([^"]+)"/.exec(source)?.[1]
    expect(version).toBe(TERMS_VERSION)
  })
})
