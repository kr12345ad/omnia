import { plugin } from "bun"
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// auth.ts imports Electron main-process modules that only exist inside a
// running app. Substitute the narrow surface it touches (app paths, safe
// storage, shell, ipcMain) and capture registered handlers so the IPC layer
// can be driven the way the renderer would.
const userData = mkdtempSync(join(tmpdir(), "omnia-auth-"))
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
const opened: string[] = []
let encryptionAvailable = true

const fakeElectron = {
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (value: string) => Buffer.from(`omnia-test:${value}`, "utf8"),
    decryptString: (value: Buffer) => {
      const text = Buffer.from(value).toString("utf8")
      if (!text.startsWith("omnia-test:")) throw new Error("not produced by the test safe storage")
      return text.slice("omnia-test:".length)
    },
  },
  shell: {
    openExternal: async (url: string) => {
      opened.push(url)
    },
  },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    },
  },
}

plugin({
  name: "omnia-auth-electron",
  setup(build) {
    build.module("electron", () => ({ exports: { ...fakeElectron, default: fakeElectron }, loader: "object" }))
  },
})

const controlPlane = "https://control.example/omnia"
let controlPlaneUrl: string | undefined = controlPlane
mock.module("./remote-agent", () => ({ readControlPlaneUrl: () => controlPlaneUrl }))

const auth = await import("./auth")
auth.registerGitHubAuthIpcHandlers()

const sessionPath = join(userData, "auth-session.json")
const requests: { url: string; body: Record<string, unknown> }[] = []
let responses: Response[] = []
const originalFetch = globalThis.fetch

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function mockFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    requests.push({ url: String(input), body })
    return responses.shift() ?? jsonResponse({ ok: true, authenticated: false })
  }) as unknown as typeof fetch
}

beforeEach(() => {
  rmSync(sessionPath, { force: true })
  requests.length = 0
  responses = []
  opened.length = 0
  controlPlaneUrl = controlPlane
  encryptionAvailable = true
  delete process.env.OMNIA_SAFE_STORAGE
  mockFetch()
})

afterAll(() => {
  globalThis.fetch = originalFetch
  rmSync(userData, { force: true, recursive: true })
})

describe("auth status", () => {
  test("reports signed out against the configured control plane", () => {
    expect(auth.authStatus()).toEqual({ authenticated: false, controlPlaneUrl: controlPlane })
  })

  test("falls back to the deployment control plane when none is configured", () => {
    controlPlaneUrl = undefined
    expect(auth.authStatus().controlPlaneUrl).toBe("https://openfoodpantry.org/test1/omnia")
  })
})

describe("sign-in flow", () => {
  test("opens the browser, polls, and stores an encrypted session", async () => {
    responses = [
      jsonResponse({
        ok: true,
        authorizeUrl: "https://github.com/login/oauth/authorize?client_id=test",
        state: "state-1",
      }),
      jsonResponse({ ok: true, authenticated: false }),
      jsonResponse({
        ok: true,
        authenticated: true,
        profile: {
          id: 7,
          login: "octocat",
          name: "The Octocat",
          avatarUrl: "https://avatars.example/7",
          htmlUrl: "https://github.com/octocat",
        },
        clientToken: "client-token-1",
      }),
    ]

    const status = await auth.startSignIn({ intervalMs: 1, timeoutMs: 1000 })

    expect(opened).toEqual(["https://github.com/login/oauth/authorize?client_id=test"])
    expect(requests.map((request) => request.url)).toEqual([
      `${controlPlane}/v1/auth/github/start`,
      `${controlPlane}/v1/auth/github/poll`,
      `${controlPlane}/v1/auth/github/poll`,
    ])
    expect(requests[0].body).toEqual({})
    expect(requests[1].body).toEqual({ state: "state-1" })
    expect(status.authenticated).toBe(true)
    expect(status.profile?.login).toBe("octocat")
    expect(status.controlPlaneUrl).toBe(controlPlane)

    const stored = JSON.parse(readFileSync(sessionPath, "utf8")) as { encrypted?: boolean; payload?: string }
    expect(stored.encrypted).toBe(true)
    expect(stored.payload).not.toContain("client-token-1")
    expect(statSync(sessionPath).mode & 0o777).toBe(0o600)
    expect(auth.loadAuthSession()).toEqual({
      url: controlPlane,
      clientToken: "client-token-1",
      profile: {
        id: 7,
        login: "octocat",
        name: "The Octocat",
        avatarUrl: "https://avatars.example/7",
        htmlUrl: "https://github.com/octocat",
      },
    })
    expect(auth.authStatus().authenticated).toBe(true)
  })

  test("falls back to plaintext with owner-only permissions when encryption is unavailable", async () => {
    encryptionAvailable = false
    process.env.OMNIA_SAFE_STORAGE = "0"
    responses = [
      jsonResponse({ ok: true, authorizeUrl: "https://github.com/login/oauth/authorize", state: "state-2" }),
      jsonResponse({
        ok: true,
        authenticated: true,
        profile: { id: 8, login: "hubot" },
        clientToken: "client-token-2",
      }),
    ]

    await auth.startSignIn({ intervalMs: 1, timeoutMs: 1000 })

    const stored = JSON.parse(readFileSync(sessionPath, "utf8")) as {
      encrypted?: boolean
      clientToken?: string
    }
    expect(stored.encrypted).toBeUndefined()
    expect(stored.clientToken).toBe("client-token-2")
    expect(statSync(sessionPath).mode & 0o777).toBe(0o600)
    expect(auth.authStatus().authenticated).toBe(true)
  })

  test("rejects a start response without an authorize URL", async () => {
    responses = [jsonResponse({ ok: true, state: "state-3" })]
    await expect(auth.startSignIn({ intervalMs: 1, timeoutMs: 1000 })).rejects.toThrow(
      "did not return a GitHub sign-in URL",
    )
  })

  test("fails fast when the poll endpoint rejects the state", async () => {
    responses = [
      jsonResponse({ ok: true, authorizeUrl: "https://github.com/login/oauth/authorize", state: "state-4" }),
      jsonResponse({ error: "Unknown sign-in state." }, 400),
    ]
    await expect(auth.startSignIn({ intervalMs: 1, timeoutMs: 500 })).rejects.toThrow("Unknown sign-in state.")
  })

  test("times out after the bounded poll window", async () => {
    responses = [jsonResponse({ ok: true, authorizeUrl: "https://github.com/login/oauth/authorize", state: "state-5" })]
    await expect(auth.startSignIn({ intervalMs: 1, timeoutMs: 20 })).rejects.toThrow(
      "Timed out waiting for GitHub sign-in.",
    )
  })
})

describe("sign out", () => {
  test("clears the stored session", async () => {
    responses = [
      jsonResponse({ ok: true, authorizeUrl: "https://github.com/login/oauth/authorize", state: "state-6" }),
      jsonResponse({ ok: true, authenticated: true, clientToken: "client-token-3" }),
    ]
    await auth.startSignIn({ intervalMs: 1, timeoutMs: 1000 })
    expect(existsSync(sessionPath)).toBe(true)

    const status = auth.signOut()

    expect(status.authenticated).toBe(false)
    expect(existsSync(sessionPath)).toBe(false)
    expect(auth.authStatus().authenticated).toBe(false)
  })
})

describe("stored credential safety", () => {
  test("refuses to write the session through a symlink", () => {
    const attacker = join(userData, "attacker.json")
    writeFileSync(attacker, JSON.stringify({ url: controlPlane, clientToken: "attacker" }))
    symlinkSync(attacker, sessionPath)

    expect(() => auth.persistAuthSession({ url: controlPlane, clientToken: "client-token-4" })).toThrow("symlink")

    // The link is refused before anything is written, so the file it points at
    // never receives the client token.
    expect(readFileSync(attacker, "utf8")).toContain("attacker")
    expect(lstatSync(sessionPath).isSymbolicLink()).toBe(true)
  })

  test("reports a stored session that can no longer be decrypted instead of looking signed out", () => {
    process.env.OMNIA_SAFE_STORAGE = "0"
    encryptionAvailable = true
    writeFileSync(sessionPath, JSON.stringify({ encrypted: true, payload: "not-from-this-keychain" }))

    expect(auth.loadAuthSession()).toBeUndefined()
    expect(auth.authStatus()).toMatchObject({
      authenticated: false,
      issue: { code: "keychain_unavailable" },
    })
  })

  test("reports a keychain that is available but cannot open the ciphertext", () => {
    encryptionAvailable = true
    writeFileSync(sessionPath, JSON.stringify({ encrypted: true, payload: "garbage" }))

    expect(auth.authStatus()).toMatchObject({
      authenticated: false,
      issue: { code: "session_unreadable" },
    })
  })

  test("reports a session that had to be stored in the clear", () => {
    encryptionAvailable = false
    process.env.OMNIA_SAFE_STORAGE = "0"
    auth.persistAuthSession({ url: controlPlane, clientToken: "client-token-5" })

    const status = auth.authStatus()
    expect(status.authenticated).toBe(true)
    expect(status.issue?.code).toBe("plaintext_storage")
    expect(statSync(sessionPath).mode & 0o777).toBe(0o600)
  })
})

describe("auth IPC surface", () => {
  test("registers status, sign-in, and sign-out handlers", async () => {
    expect([...handlers.keys()]).toEqual(
      expect.arrayContaining(["omnia-auth-status", "omnia-auth-sign-in", "omnia-auth-sign-out"]),
    )
    expect(await handlers.get("omnia-auth-status")!({})).toEqual({
      authenticated: false,
      controlPlaneUrl: controlPlane,
    })
  })
})
