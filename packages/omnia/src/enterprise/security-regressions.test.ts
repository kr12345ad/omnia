import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EnterpriseRuntime } from "./runtime"
import { openEnterpriseStore } from "./store"
import { verifyPassword } from "./password"

const cleanup: (() => void)[] = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })
const password = "correct horse battery"
function file() {
  const dir = mkdtempSync(join(tmpdir(), "enterprise-security-"))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, "store.json")
}
function store() { return openEnterpriseStore({ file: file(), orgName: "Acme" }) }

async function consoleServer() {
  const runtime = new EnterpriseRuntime({ file: file(), publicUrl: "http://console.test", version: "test", build: false })
  const server = createServer((req, res) => { void runtime.handle(req, res) })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(() => server.close())
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No server address")
  const post = (token: string, cookie: boolean, path: string, body: object) => fetch(`http://127.0.0.1:${address.port}/v1/enterprise/${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie: `omnia_enterprise=${token}` } : { authorization: `Bearer ${token}` }) }, body: JSON.stringify(body),
  })
  return { runtime, post }
}

test("role denial stops mutations, including nested route handlers", async () => {
  const { runtime, post } = await consoleServer()
  const member = await runtime.store.createUser({ email: "member@acme.test", name: "Member", role: "member", password })
  const { token } = runtime.store.createSession(member.id, "admin", {})
  expect((await post(token, false, "users", { email: "intruder@acme.test", name: "Intruder", role: "admin", password })).status).toBe(403)
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(runtime.store.findByIdentifier("intruder@acme.test")).toBeUndefined()
  expect((await post(token, false, "scim/token", {})).status).toBe(403)
  expect(runtime.store.auditAll().some((e) => e.action === "scim.token_rotated")).toBe(false)
})

test("CSRF denial stops cookie-authenticated mutations", async () => {
  const { runtime, post } = await consoleServer()
  const owner = await runtime.store.createUser({ email: "owner@acme.test", name: "Owner", role: "owner", password })
  const { token } = runtime.store.createSession(owner.id, "admin", {})
  expect((await post(token, true, "users", { email: "csrf@acme.test", name: "CSRF", password })).status).toBe(403)
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(runtime.store.findByIdentifier("csrf@acme.test")).toBeUndefined()
  expect((await post(token, true, "scim/token", {})).status).toBe(403)
  expect(runtime.store.auditAll().some((e) => e.action === "scim.token_rotated")).toBe(false)
  expect((await post(token, false, "users", { email: "allowed@acme.test", name: "Allowed", password })).status).toBe(200)
})

test("setup token admits only one owner under concurrent hashing", async () => {
  const s = store()
  const token = s.bootstrap()!.token
  const results = await Promise.allSettled(["a", "b"].map((name) => s.setup({ token, email: `${name}@acme.test`, name, password })))
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
  expect(s.users().filter((u) => u.role === "owner")).toHaveLength(1)
})

test("invitation is consumed once across concurrent acceptance", async () => {
  const s = store()
  const { token } = s.invite({ email: "invite@acme.test", role: "member", createdBy: "test" })
  const results = await Promise.allSettled([s.acceptInvite(token, password), s.acceptInvite(token, password)])
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
})

test("revocation during invitation hashing prevents activation", async () => {
  const s = store()
  const { token, invite } = s.invite({ email: "invite@acme.test", role: "member", createdBy: "test" })
  const pending = s.acceptInvite(token, password)
  s.revokeInvite(invite.id)
  await expect(pending).rejects.toThrow()
  expect(s.findByIdentifier("invite@acme.test")).toBeUndefined()
})

test("pending login cannot overwrite suspension or role changes", async () => {
  const s = store()
  const user = await s.createUser({ email: "user@acme.test", name: "User", role: "admin", password })
  const pending = s.login(user.email, password)
  s.updateUser(user.id, { status: "suspended", role: "member" })
  expect((await pending).ok).toBe(false)
  expect(s.user(user.id)?.status).toBe("suspended")
  expect(s.user(user.id)?.role).toBe("member")
})

test("concurrent createUser calls preserve email uniqueness", async () => {
  const s = store()
  const results = await Promise.allSettled([1, 2].map(() => s.createUser({ email: "same@acme.test", name: "Same", role: "member", password })))
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
  expect(s.users()).toHaveLength(1)
})

test("malformed scrypt parameters fail verification without throwing", async () => {
  const encoded = `scrypt$1025$8$1$AAAAAAAAAAAAAAAAAAAAAA$${Buffer.alloc(64).toString("base64url")}`
  expect(await verifyPassword(password, encoded)).toBe(false)
})


test("owner can issue a reset link through the advertised route", async () => {
  const { runtime, post } = await consoleServer()
  const owner = await runtime.store.createUser({ email: "owner@acme.test", name: "Owner", role: "owner", password })
  const { token } = runtime.store.createSession(owner.id, "admin", {})
  const response = await post(token, false, `users/${owner.id}/reset`, {})
  expect(response.status).toBe(200)
  expect((await response.json()).token).toStartWith("oms_reset_")
})

test("reset-link acceptance revokes previously issued credentials", async () => {
  const s = store()
  const user = await s.createUser({ email: "reset@acme.test", name: "Reset", role: "member", password })
  const previous = s.createSession(user.id, "admin", {})
  const client = s.createSession(user.id, "client", {})
  const reset = s.createResetToken(user.id)
  await s.acceptInvite(reset.token, "another secure password")
  expect(s.verifySession(previous.token, "admin")).toBeUndefined()
  expect(s.verifySession(client.token, "client")).toBeUndefined()
})

test("non-owner cannot obtain an owner's password reset token", async () => {
  const { runtime, post } = await consoleServer()
  const owner = await runtime.store.createUser({ email: "owner@acme.test", name: "Owner", role: "owner", password })
  const admin = await runtime.store.createUser({ email: "admin@acme.test", name: "Admin", role: "admin", password })
  const { token } = runtime.store.createSession(admin.id, "admin", {})
  expect((await post(token, false, `users/${owner.id}/reset`, {})).status).toBe(403)
  expect(runtime.store.invites()).toHaveLength(0)
})
