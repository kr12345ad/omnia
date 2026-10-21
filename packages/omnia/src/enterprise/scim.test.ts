import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EnterpriseRuntime } from "./runtime"

// SCIM is how a customer's identity provider owns people and teams. Group
// membership is what drives model access and the per-team limits, so a
// read-only Groups resource meant an IdP could create a person and never put
// them anywhere. These tests drive the real handler over HTTP.

const directories: string[] = []
const servers: { close: () => void }[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function controlPlane() {
  const directory = mkdtempSync(join(tmpdir(), "omnia-enterprise-scim-"))
  directories.push(directory)
  const runtime = new EnterpriseRuntime({
    file: join(directory, "enterprise.json"),
    publicUrl: "http://127.0.0.1:8787",
    orgName: "Acme Robotics",
    version: "1.0.3",
    build: false,
  })
  const token = runtime.store.bootstrap()!.token
  await runtime.store.setup({ token, email: "owner@acme.test", name: "Owner", password: "correct horse battery" })
  const scim = runtime.store.rotateScimToken("usr_owner")
  const server = createServer((request, response) => {
    void runtime.handle(request, response).catch(() => {
      response.statusCode = 500
      response.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push({ close: () => server.close() })
  const port = (server.address() as AddressInfo).port
  const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/enterprise/scim/v2${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${scim}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    const text = await response.text()
    return { status: response.status, body: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>) }
  }
  return { runtime, call }
}

type Call = Awaited<ReturnType<typeof controlPlane>>["call"]

async function createUser(call: Call, userName: string) {
  const created = await call("/Users", {
    method: "POST",
    body: { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName, name: { givenName: "Ada", familyName: "Lovelace" } },
  })
  expect(created.status).toBe(201)
  return created.body
}

describe("SCIM provisioning", () => {
  test("creates a user, refuses a duplicate, and deactivates with PATCH", async () => {
    const { call } = await controlPlane()
    const user = await createUser(call, "ada@acme.test")
    expect(user.userName).toBe("ada@acme.test")
    expect(user.name).toMatchObject({ givenName: "Ada", familyName: "Lovelace" })

    const duplicate = await call("/Users", {
      method: "POST",
      body: { userName: "ada@acme.test", name: { formatted: "Ada" } },
    })
    expect(duplicate.status).toBe(409)

    const deactivated = await call(`/Users/${String(user.id)}`, {
      method: "PATCH",
      body: { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "replace", path: "active", value: false }] },
    })
    expect(deactivated.status).toBe(200)
    expect(deactivated.body.active).toBe(false)

    const renamed = await call(`/Users/${String(user.id)}`, {
      method: "PATCH",
      body: { Operations: [{ op: "replace", path: "userName", value: "grace@acme.test" }] },
    })
    expect(renamed.status).toBe(400)
    expect(renamed.body.scimType).toBe("mutability")
  })

  test("creates a group, syncs membership, and deletes it", async () => {
    const { runtime, call } = await controlPlane()
    const ada = await createUser(call, "ada@acme.test")
    const grace = await createUser(call, "grace@acme.test")

    const created = await call("/Groups", {
      method: "POST",
      body: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        displayName: "Research",
        members: [{ value: ada.id }],
      },
    })
    expect(created.status).toBe(201)
    const groupId = String(created.body.id)
    expect(runtime.store.user(String(ada.id))?.groupIds).toEqual([groupId])

    const added = await call(`/Groups/${groupId}`, {
      method: "PATCH",
      body: {
        Operations: [{ op: "add", path: "members", value: [{ value: grace.id }] }],
      },
    })
    expect(added.status).toBe(200)
    expect((added.body.members as { value: string }[]).map((member) => member.value).sort()).toEqual(
      [String(ada.id), String(grace.id)].sort(),
    )

    const removed = await call(`/Groups/${groupId}`, {
      method: "PATCH",
      body: {
        Operations: [{ op: "remove", path: "members", value: [{ value: ada.id }] }],
      },
    })
    expect((removed.body.members as { value: string }[]).map((member) => member.value)).toEqual([String(grace.id)])
    expect(runtime.store.user(String(ada.id))?.groupIds).toEqual([])

    const duplicate = await call("/Groups", { method: "POST", body: { displayName: "research" } })
    expect(duplicate.status).toBe(409)

    const list = await call("/Groups?filter=displayName%20eq%20%22Research%22&startIndex=1&count=1")
    expect(list.status).toBe(200)
    expect(list.body.totalResults).toBe(1)
    expect((list.body.Resources as { displayName: string }[])[0]?.displayName).toBe("Research")

    const deleted = await call(`/Groups/${groupId}`, { method: "DELETE" })
    expect(deleted.status).toBe(204)
    expect(runtime.store.groups()).toHaveLength(0)
    expect(runtime.store.user(String(grace.id))?.groupIds).toEqual([])
  })

  test("replaces a group with PUT and keeps its role out of directory hands", async () => {
    const { runtime, call } = await controlPlane()
    const ada = await createUser(call, "ada@acme.test")
    const group = await call("/Groups", { method: "POST", body: { displayName: "Field" } })
    const groupId = String(group.body.id)
    expect(runtime.store.groups()[0]?.role).toBe("member")

    const replaced = await call(`/Groups/${groupId}`, {
      method: "PUT",
      body: { displayName: "Field Ops", members: [{ value: ada.id }] },
    })
    expect(replaced.status).toBe(200)
    expect(replaced.body.displayName).toBe("Field Ops")
    expect(runtime.store.user(String(ada.id))?.groupIds).toEqual([groupId])
  })
})
