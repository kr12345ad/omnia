import { describe, expect, test } from "bun:test"
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto"
import { verifyGChat } from "./verify"

const keys = generateKeyPairSync("rsa", { modulusLength: 2_048 })
const jwk = { ...(keys.publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "test-key", alg: "RS256", use: "sig" }

const jwks = Bun.serve({
  port: 0,
  fetch: () => Response.json({ keys: [jwk] }),
})

const jwksUrl = `http://127.0.0.1:${jwks.port}/certs`
const AUDIENCE = "https://openfoodpantry.org/test1/omnia/v1/chat/gchat/webhook"
const CHAT_APP = "service-123456789@gcp-sa-gsuiteaddons.iam.gserviceaccount.com"

function sign(claims: Record<string, unknown>, options: { kid?: string; key?: KeyObject } = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: options.kid ?? "test-key" })).toString(
    "base64url",
  )
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(options.key ?? keys.privateKey)
    .toString("base64url")
  return `${header}.${payload}.${signature}`
}

const bearer = (token: string) => new Headers({ authorization: `Bearer ${token}` })

const claims = (overrides: Record<string, unknown> = {}) => ({
  aud: AUDIENCE,
  exp: Math.floor(Date.now() / 1_000) + 300,
  iat: Math.floor(Date.now() / 1_000),
  email: CHAT_APP,
  email_verified: true,
  iss: "https://accounts.google.com",
  ...overrides,
})

const check = (headers: Headers, audience = AUDIENCE) => verifyGChat(headers, { audience, jwksUrl })

describe("google chat request verification", () => {
  test("accepts a token Google signed for this app's audience", async () => {
    expect(await check(bearer(sign(claims())))).toEqual({ ok: true })
  })

  test("accepts the array audience form", async () => {
    expect(await check(bearer(sign(claims({ aud: ["other", AUDIENCE] }))))).toEqual({ ok: true })
  })

  test("refuses a token minted for a different endpoint", async () => {
    const result = await check(bearer(sign(claims({ aud: "https://evil.example/webhook" }))))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("audience")
  })

  test("refuses an expired token", async () => {
    const result = await check(bearer(sign(claims({ exp: Math.floor(Date.now() / 1_000) - 30 }))))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("expired")
  })

  test("refuses a token whose signature does not match the published key", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2_048 })
    const result = await check(bearer(sign(claims(), { key: other.privateKey })))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("signature")
  })

  test("refuses a token signed for something other than a Chat app", async () => {
    const result = await check(bearer(sign(claims({ email: "someone@example.com" }))))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("Chat app")
  })

  test("refuses an unknown key id and a non-JWT bearer", async () => {
    expect((await check(bearer(sign(claims(), { kid: "nope" })))).ok).toBe(false)
    const opaque = await check(new Headers({ authorization: "Bearer AbCdEf123456" }))
    expect(opaque.ok).toBe(false)
    expect(opaque.reason).toContain("not a JWT")
  })

  test("refuses a request with no bearer and one with no audience configured", async () => {
    expect((await check(new Headers())).ok).toBe(false)
    const unconfigured = await check(bearer(sign(claims())), "")
    expect(unconfigured.ok).toBe(false)
    expect(unconfigured.reason).toContain("audience")
  })
})
