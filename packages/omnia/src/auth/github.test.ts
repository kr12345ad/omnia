import { afterEach, describe, expect, test } from "bun:test"
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  GITHUB_API_EMAILS,
  GITHUB_API_USER,
  GITHUB_OAUTH_TOKEN,
  GitHubAuth,
  renderGitHubCallbackPage,
  type GitHubAuthOptions,
} from "./github"

const dirs: string[] = []
const redirect = "https://control.example/omnia/v1/auth/github/callback"

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.OMNIA_GITHUB_REDIRECT_URI
})

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnia-auth-"))
  dirs.push(dir)
  return join(dir, "auth.json")
}

function fakeFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    if (url === GITHUB_OAUTH_TOKEN) {
      const body = String(init?.body ?? "")
      if (!body.includes("code_verifier=")) return Response.json({ error: "missing_code_verifier" })
      return Response.json({ access_token: "gho_test_token" })
    }
    if (url === GITHUB_API_USER) {
      return Response.json({
        id: 583231,
        login: "octocat",
        name: "The Octocat",
        avatar_url: "https://avatars.githubusercontent.com/u/583231",
        html_url: "https://github.com/octocat",
      })
    }
    if (url === GITHUB_API_EMAILS) {
      return Response.json([{ email: "octocat@github.com", primary: true, verified: true }])
    }
    return fetch(input, init)
  }) as typeof fetch
}

function configured(overrides: Partial<GitHubAuthOptions> = {}): GitHubAuth {
  return new GitHubAuth({
    file: tempFile(),
    fetchImpl: fakeFetch(),
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    redirectUri: redirect,
    ...overrides,
  })
}

describe("github auth public callback", () => {
  test("builds an authorize URL with the public redirect and PKCE", async () => {
    const auth = configured()
    const started = await auth.start("browser")
    const url = new URL(started.authorizeUrl)
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize")
    expect(url.searchParams.get("client_id")).toBe("test-client-id")
    expect(url.searchParams.get("redirect_uri")).toBe(redirect)
    expect(url.searchParams.get("scope")).toBe("read:user user:email")
    expect(url.searchParams.get("state")).toBe(started.state)
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("code_challenge")?.length).toBeGreaterThan(20)
    expect(started.redirectUri).toBe(redirect)
    expect(started.status.authenticated).toBe(false)
    expect(auth.poll(started.state)).toEqual({ authenticated: false })
  })

  test("defaults the redirect to the public URL callback path", async () => {
    const auth = configured({ redirectUri: undefined, publicUrl: "https://control.example/omnia/" })
    const started = await auth.start()
    expect(started.redirectUri).toBe(redirect)
    expect(auth.redirectUri()).toBe(redirect)
  })

  test("honors OMNIA_GITHUB_REDIRECT_URI when no option is set", async () => {
    process.env.OMNIA_GITHUB_REDIRECT_URI = redirect
    const auth = configured({ redirectUri: undefined })
    expect(auth.redirectUri()).toBe(redirect)
    const started = await auth.start()
    expect(new URL(started.authorizeUrl).searchParams.get("redirect_uri")).toBe(redirect)
  })

  test("requires a public callback URL", async () => {
    const auth = configured({ redirectUri: undefined })
    await expect(auth.start("browser")).rejects.toThrow(/callback URL/i)
  })

  test("removes the device, loopback, and gh sign-in methods", async () => {
    const auth = configured()
    await expect(auth.start("device")).rejects.toThrow(/"device" is not supported/)
    await expect(auth.start("loopback")).rejects.toThrow(/"loopback" is not supported/)
    await expect(auth.start("gh")).rejects.toThrow(/"gh" is not supported/)
  })

  test("completes a pending flow and issues a client token", async () => {
    const auth = configured()
    const started = await auth.start()
    const result = await auth.completeCallback(started.state, "test-code")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.profile.login).toBe("octocat")
    expect(result.profile.email).toBe("octocat@github.com")
    expect(result.clientToken).toMatch(/^[0-9a-f]{64}$/)
    expect(auth.isClientToken(result.clientToken)).toBe(true)
    expect(auth.isClientToken("0".repeat(64))).toBe(false)
    expect(auth.status().authenticated).toBe(true)
    expect(auth.status().profile?.login).toBe("octocat")
    expect(auth.status().oauthClientConfigured).toBe(true)
  })

  test("returns the client token exactly once through poll", async () => {
    const auth = configured()
    const started = await auth.start()
    const callback = await auth.completeCallback(started.state, "test-code")
    expect(callback.ok).toBe(true)
    if (!callback.ok) return
    const first = auth.poll(started.state)
    expect(first?.authenticated).toBe(true)
    expect(first?.profile?.login).toBe("octocat")
    expect(first?.clientToken).toBe(callback.clientToken)
    const second = auth.poll(started.state)
    expect(second?.authenticated).toBe(true)
    expect(second?.clientToken).toBeUndefined()
    expect(auth.poll("0".repeat(48))).toBeUndefined()
  })

  test("rejects an unknown or expired callback state", async () => {
    const auth = configured()
    const unknown = await auth.completeCallback("0".repeat(48), "test-code")
    expect(unknown.ok).toBe(false)
    if (unknown.ok) return
    expect(unknown.status).toBe(400)
    expect(unknown.message).toMatch(/unknown or has expired/)

    let now = 1000
    const expiring = configured({ now: () => now, timeoutMs: 1000 })
    const started = await expiring.start()
    now += 1001
    const expired = await expiring.completeCallback(started.state, "test-code")
    expect(expired.ok).toBe(false)
    if (expired.ok) return
    expect(expired.status).toBe(400)
    expect(expiring.poll(started.state)).toBeUndefined()
  })

  test("surfaces an exchange failure without switching identity", async () => {
    const failingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url === GITHUB_OAUTH_TOKEN) {
        return Response.json({ error: "bad_verification_code", error_description: "<script>alert(1)</script>" })
      }
      return fakeFetch()(input, init)
    }) as typeof fetch
    const auth = configured({ fetchImpl: failingFetch })
    const started = await auth.start()
    const result = await auth.completeCallback(started.state, "test-code")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(500)
    expect(result.message).toContain("<script>alert(1)</script>")
    expect(auth.status().authenticated).toBe(false)
  })

  test("persists the session and restores it on the next launch", async () => {
    const file = tempFile()
    const auth = configured({ file })
    const started = await auth.start()
    await auth.completeCallback(started.state, "test-code")
    const stored = JSON.parse(readFileSync(file, "utf8")) as { profile?: { login?: string }; token?: string }
    expect(stored.profile?.login).toBe("octocat")
    expect(stored.token).toBe("gho_test_token")
    const restored = new GitHubAuth({ file })
    expect(restored.status().authenticated).toBe(true)
    expect(restored.status().profile?.login).toBe("octocat")
  })

  test("starts cleanly from a corrupt auth file", () => {
    const file = tempFile()
    writeFileSync(file, "{ not json")
    const auth = new GitHubAuth({ file })
    expect(auth.status().authenticated).toBe(false)
  })

  test("escapes error text in the callback page", () => {
    const page = renderGitHubCallbackPage("Sign-in failed", "<script>alert(1)</script>")
    expect(page).not.toContain("<script>")
    expect(page).toContain("&lt;script&gt;")
    expect(page).toContain("color-scheme: dark light")
  })

  test("logout clears the session and client tokens", async () => {
    const auth = configured()
    const started = await auth.start()
    const callback = await auth.completeCallback(started.state, "test-code")
    expect(callback.ok).toBe(true)
    if (!callback.ok) return
    await auth.logout()
    expect(auth.status().authenticated).toBe(false)
    expect(auth.isClientToken(callback.clientToken)).toBe(false)
    expect(auth.poll(started.state)).toBeUndefined()
  })

  test("saving an OAuth client keeps an existing signed-in session", async () => {
    const file = tempFile()
    const auth = configured({ file })
    const started = await auth.start()
    await auth.completeCallback(started.state, "test-code")
    expect(auth.status().authenticated).toBe(true)
    const status = auth.saveOAuthClient("Ov23liTest", "secret-value")
    expect(status.oauthClientConfigured).toBe(true)
    const restored = new GitHubAuth({ file })
    expect(restored.status().authenticated).toBe(true)
    expect(restored.status().profile?.login).toBe("octocat")
    expect(restored.status().oauthClientConfigured).toBe(true)
  })
})

describe("github auth file safety", () => {
  test("refuses to write the token file through a symlink", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-auth-"))
    dirs.push(dir)
    const file = join(dir, "auth.json")
    const attacker = join(dir, "attacker.json")
    writeFileSync(attacker, "{}")
    symlinkSync(attacker, file)
    const auth = configured({ file })
    const started = await auth.start()

    await expect(auth.completeCallback(started.state, "test-code")).rejects.toThrow("symlink")

    // The symlink is refused before anything is written, so the file it points
    // at never receives the OAuth token.
    expect(readFileSync(attacker, "utf8")).toBe("{}")
    expect(lstatSync(file).isSymbolicLink()).toBe(true)
  })

  test("refuses to write the client tokens through a symlink", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-auth-"))
    dirs.push(dir)
    const file = join(dir, "auth.json")
    const attacker = join(dir, "attacker.json")
    writeFileSync(attacker, "{}")
    symlinkSync(attacker, `${file}.clients.json`)
    const auth = configured({ file })
    const started = await auth.start()

    // A refused client-token write must not break sign-in, only the persistence.
    await auth.completeCallback(started.state, "test-code")
    expect(auth.status().authenticated).toBe(true)
    expect(readFileSync(attacker, "utf8")).toBe("{}")
  })
})
