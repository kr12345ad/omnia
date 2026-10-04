import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GITHUB_API_EMAILS, GITHUB_API_USER, GITHUB_OAUTH_TOKEN } from "../auth/github"
import { createRemoteKeyPair, remoteAuthHeaders } from "../remote"
import { startOmniaServer } from "./server"

function fakeGitHubFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    if (url === GITHUB_OAUTH_TOKEN) {
      const body = String(init?.body ?? "")
      if (!body.includes("code_verifier=") || !body.includes("client_secret=")) {
        return Response.json({ error: "missing_pkce" })
      }
      return Response.json({ access_token: "gho_test_token" })
    }
    if (url === GITHUB_API_USER) {
      return Response.json({ id: 583231, login: "octocat", name: "The Octocat" })
    }
    if (url === GITHUB_API_EMAILS) {
      return Response.json([{ email: "octocat@github.com", primary: true, verified: true }])
    }
    return fetch(input, init)
  }) as typeof fetch
}

async function withServer<T>(
  fn: (server: Awaited<ReturnType<typeof startOmniaServer>>) => Promise<T>,
  now?: () => number,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "omnia-server-auth-"))
  const server = await startOmniaServer({
    token: "operator-token",
    publicUrl: "https://control.example/omnia",
    githubClientId: "test-client-id",
    githubClientSecret: "test-client-secret",
    githubFetch: fakeGitHubFetch(),
    ...(now === undefined ? {} : { now }),
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

const operatorAuth = (server: { token: string }) => ({
  authorization: `Bearer ${server.token}`,
  "content-type": "application/json",
})

async function startFlow(server: { url: string; token: string }) {
  const response = await fetch(`${server.url}/v1/auth/github/start`, {
    method: "POST",
    headers: operatorAuth(server),
    body: JSON.stringify({ method: "browser" }),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as {
    authorizeUrl: string
    state: string
    redirectUri: string
    status: { authenticated: boolean }
  }
}

async function completeFlow(server: { url: string; token: string }) {
  const started = await startFlow(server)
  const callback = await fetch(`${server.url}/v1/auth/github/callback?code=test-code&state=${started.state}`)
  expect(callback.status).toBe(200)
  const poll = await fetch(`${server.url}/v1/auth/github/poll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state: started.state }),
  })
  expect(poll.status).toBe(200)
  const body = (await poll.json()) as { clientToken?: string }
  expect(body.clientToken).toBeDefined()
  return { started, clientToken: body.clientToken ?? "" }
}

describe("github auth routes", () => {
  test("starts a browser flow against the public callback URL", async () => {
    await withServer(async (server) => {
      const started = await startFlow(server)
      expect(started.redirectUri).toBe("https://control.example/omnia/v1/auth/github/callback")
      const authorize = new URL(started.authorizeUrl)
      expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize")
      expect(authorize.searchParams.get("redirect_uri")).toBe(started.redirectUri)
      expect(authorize.searchParams.get("client_id")).toBe("test-client-id")
      expect(authorize.searchParams.get("code_challenge_method")).toBe("S256")
      expect(authorize.searchParams.get("state")).toBe(started.state)
      expect(started.status.authenticated).toBe(false)
    })
  })

  test("completes the public callback and answers status and poll without auth", async () => {
    await withServer(async (server) => {
      const started = await startFlow(server)
      const callback = await fetch(`${server.url}/v1/auth/github/callback?code=test-code&state=${started.state}`)
      expect(callback.status).toBe(200)
      expect(callback.headers.get("content-type")).toContain("text/html")
      const page = await callback.text()
      expect(page).toContain("close this tab")
      expect(page).toContain("color-scheme: dark light")

      const status = await fetch(`${server.url}/v1/auth/github/status`)
      expect(status.status).toBe(200)
      const statusBody = (await status.json()) as {
        ok: boolean
        status: { authenticated: boolean; profile?: { login?: string }; oauthClientConfigured: boolean }
      }
      expect(statusBody.ok).toBe(true)
      expect(statusBody.status.authenticated).toBe(true)
      expect(statusBody.status.profile?.login).toBe("octocat")
      expect(statusBody.status.oauthClientConfigured).toBe(true)

      const poll = await fetch(`${server.url}/v1/auth/github/poll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: started.state }),
      })
      expect(poll.status).toBe(200)
      const pollBody = (await poll.json()) as { authenticated: boolean; profile?: { login?: string }; clientToken?: string }
      expect(pollBody.authenticated).toBe(true)
      expect(pollBody.profile?.login).toBe("octocat")
      expect(pollBody.clientToken).toMatch(/^[0-9a-f]{64}$/)
    })
  })

  test("returns the client token exactly once", async () => {
    await withServer(async (server) => {
      const { started, clientToken } = await completeFlow(server)
      const again = await fetch(`${server.url}/v1/auth/github/poll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: started.state }),
      })
      const body = (await again.json()) as { authenticated: boolean; clientToken?: string }
      expect(body.authenticated).toBe(true)
      expect(body.clientToken).toBeUndefined()
      expect(clientToken).toMatch(/^[0-9a-f]{64}$/)

      const unknown = await fetch(`${server.url}/v1/auth/github/poll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: "0".repeat(48) }),
      })
      expect(unknown.status).toBe(400)
    })
  })

  test("authorizes normal API calls with a client token", async () => {
    await withServer(async (server) => {
      const { clientToken } = await completeFlow(server)
      const health = await fetch(`${server.url}/v1/health`, {
        headers: { authorization: `Bearer ${clientToken}` },
      })
      expect(health.status).toBe(200)
      const computers = await fetch(`${server.url}/v1/computers`, {
        headers: { authorization: `Bearer ${clientToken}` },
      })
      expect(computers.status).toBe(200)
      const unauthorized = await fetch(`${server.url}/v1/health`, {
        headers: { authorization: "Bearer wrong-token" },
      })
      expect(unauthorized.status).toBe(401)
    })
  })

  test("registers a runtime with a client token and accepts signed requests", async () => {
    await withServer(async (server) => {
      const { clientToken } = await completeFlow(server)
      const keys = createRemoteKeyPair()
      const registered = await fetch(`${server.url}/v1/computers/register`, {
        method: "POST",
        headers: { authorization: `Bearer ${clientToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          name: "App Runtime",
          platform: "linux",
          architecture: "x64",
          info: { id: "app-runtime", name: "App Runtime", platform: "linux", connected: true },
          capabilities: [{ capability: "accessibility", status: "available" }],
          publicKey: keys.publicKey,
        }),
      })
      expect(registered.status).toBe(200)
      const claim = (await registered.json()) as { computerId: string; token: string }
      expect(claim.computerId.startsWith("remote-")).toBe(true)

      const listed = await fetch(`${server.url}/v1/computers`, { headers: operatorAuth(server) })
      const computers = ((await listed.json()) as { computers: Array<{ id: string; backend: string }> }).computers
      expect(computers.some((computer) => computer.id === claim.computerId && computer.backend === "remote")).toBe(true)

      const url = `${server.url}/v1/computers/${claim.computerId}/remote/commands?wait=0`
      const signed = await fetch(url, {
        headers: remoteAuthHeaders({
          token: claim.token,
          computerId: claim.computerId,
          method: "GET",
          url,
          timestampMs: Date.now(),
          keys: keys.privateKey,
        }),
      })
      expect(signed.status).toBe(200)
      expect(((await signed.json()) as { command: unknown }).command).toBeNull()
    })
  })

  test("rejects runtime registration without a valid token and accepts the operator token", async () => {
    await withServer(async (server) => {
      const keys = createRemoteKeyPair()
      const body = JSON.stringify({ name: "App Runtime", platform: "linux", publicKey: keys.publicKey })
      // The operator token is the deployment root credential; it may provision
      // a runtime directly (used by admin-provisioned thin clients).
      const withOperator = await fetch(`${server.url}/v1/computers/register`, {
        method: "POST",
        headers: operatorAuth(server),
        body,
      })
      expect(withOperator.status).toBe(200)
      const anonymous = await fetch(`${server.url}/v1/computers/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
      expect(anonymous.status).toBe(401)
      const bogus = await fetch(`${server.url}/v1/computers/register`, {
        method: "POST",
        headers: { authorization: "Bearer not-a-real-token", "content-type": "application/json" },
        body,
      })
      expect(bogus.status).toBe(401)
    })
  })

  test("rejects device, loopback, and gh sign-in methods", async () => {
    await withServer(async (server) => {
      for (const method of ["device", "loopback", "gh"]) {
        const response = await fetch(`${server.url}/v1/auth/github/start`, {
          method: "POST",
          headers: operatorAuth(server),
          body: JSON.stringify({ method }),
        })
        expect(response.status).toBe(400)
        const body = (await response.json()) as { error: string }
        expect(body.error).toContain(`"${method}" is not supported`)
      }
    })
  })

  test("rejects unknown and expired callback states", async () => {
    let clock = 1_000_000
    await withServer(async (server) => {
      const unknown = await fetch(`${server.url}/v1/auth/github/callback?code=test-code&state=${"0".repeat(48)}`)
      expect(unknown.status).toBe(400)
      expect(await unknown.text()).toContain("unknown or has expired")

      const started = await startFlow(server)
      clock += 600_000
      const expired = await fetch(`${server.url}/v1/auth/github/callback?code=test-code&state=${started.state}`)
      expect(expired.status).toBe(400)
      expect(await expired.text()).toContain("unknown or has expired")
    }, () => clock)
  })

  test("reports an unconfigured OAuth client without auth", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-server-auth-"))
    const server = await startOmniaServer({
      token: "operator-token",
      authFile: join(dir, "auth.json"),
      credentialsFile: join(dir, "credentials.json"),
      superskillFile: join(dir, "superskills.json"),
      memoryFile: join(dir, "memories.json"),
      computerUseFile: join(dir, "computer-use.json"),
    })
    try {
      const status = await fetch(`${server.url}/v1/auth/github/status`)
      expect(status.status).toBe(200)
      const body = (await status.json()) as { status: { authenticated: boolean; oauthClientConfigured: boolean } }
      expect(body.status.authenticated).toBe(false)
      expect(body.status.oauthClientConfigured).toBe(false)
    } finally {
      await server.stop()
    }
  })
})

test("re-registering with the same id and key reuses the runtime entry", async () => {
  await withServer(async (server) => {
    const keys = createRemoteKeyPair()
    const body = JSON.stringify({ name: "App Runtime", platform: "linux", publicKey: keys.publicKey })
    const first = (await fetch(`${server.url}/v1/computers/register`, {
      method: "POST",
      headers: operatorAuth(server),
      body,
    }).then((r) => r.json())) as { ok: boolean; computerId: string }
    const second = (await fetch(`${server.url}/v1/computers/register`, {
      method: "POST",
      headers: operatorAuth(server),
      body: JSON.stringify({ name: "App Runtime", platform: "linux", publicKey: keys.publicKey, computerId: first.computerId }),
    }).then((r) => r.json())) as { ok: boolean; computerId: string }
    expect(second.ok).toBe(true)
    expect(second.computerId).toBe(first.computerId)
    const computers = (await fetch(`${server.url}/v1/computers`, { headers: operatorAuth(server) }).then((r) => r.json())) as {
      computers: Array<{ id: string }>
    }
    expect(computers.computers.filter((entry) => entry.id === first.computerId)).toHaveLength(1)
  })
})
