import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startOmniaServer } from "./server"

let dir = ""
let previousKey: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnia-ads-api-"))
  previousKey = process.env.GRAVITY_API_KEY
  delete process.env.GRAVITY_API_KEY
})

afterEach(() => {
  if (previousKey === undefined) delete process.env.GRAVITY_API_KEY
  else process.env.GRAVITY_API_KEY = previousKey
  rmSync(dir, { recursive: true, force: true })
})

async function withServer<T>(fn: (server: Awaited<ReturnType<typeof startOmniaServer>>) => Promise<T>): Promise<T> {
  const server = await startOmniaServer({
    credentialsFile: join(dir, "credentials.json"),
    authFile: join(dir, "auth.json"),
    superskillFile: join(dir, "superskills.json"),
    memoryFile: join(dir, "memories.json"),
    computerUseFile: join(dir, "computer-use.json"),
  })
  try {
    return await fn(server)
  } finally {
    await server.stop()
  }
}

function post(server: { url: string }, token: string | undefined, body: unknown) {
  return fetch(`${server.url}/v1/ads`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  })
}

describe("sponsored ads route", () => {
  test("an anonymous caller cannot reach the endpoint", async () => {
    await withServer(async (server) => {
      expect((await post(server, undefined, { sessionId: "s", context: "hi" })).status).toBe(401)
    })
  })

  test("the route is POST-only even for a signed-in client", async () => {
    await withServer(async (server) => {
      const token = server.auth.mintClientToken({ id: 7, login: "free" })
      if (token === undefined) throw new Error("the client token was not minted")
      const response = await fetch(`${server.url}/v1/ads`, { headers: { authorization: `Bearer ${token}` } })
      expect(response.status).toBe(404)
    })
  })

  test("a missing publisher key is an empty slot, not an error", async () => {
    await withServer(async (server) => {
      const token = server.auth.mintClientToken({ id: 7, login: "free" })
      if (token === undefined) throw new Error("the client token was not minted")
      const response = await post(server, token, { sessionId: "s", context: "close the invoices" })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true, ads: [] })
      expect(response.headers.get("cache-control")).toBe("no-store")
    })
  })

  test("a signed-in caller without a request is refused before any ad call", async () => {
    await withServer(async (server) => {
      const token = server.auth.mintClientToken({ id: 7, login: "free" })
      if (token === undefined) throw new Error("the client token was not minted")
      expect((await post(server, token, { sessionId: "s" })).status).toBe(400)
    })
  })
})
