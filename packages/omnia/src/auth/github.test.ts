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
import { GOOGLE_OAUTH_TOKEN, GOOGLE_OAUTH_USERINFO } from "./google"

const dirs: string[] = []
const redirect = "https://control.example/omnia/v1/auth/github/callback"
const googleRedirect = "https://control.example/omnia/v1/auth/google/callback"

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.OMNIA_GITHUB_REDIRECT_URI
  delete process.env.OMNIA_GOOGLE_REDIRECT_URI
})

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnia-auth-"))
  dirs.push(dir)
  return join(dir, "auth.json")
}

function fakeFetch(emails: { github?: string; google?: string } = {}): typeof fetch {
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
      return Response.json([{ email: emails.github ?? "octocat@github.com", primary: true, verified: true }])
    }
    if (url === GOOGLE_OAUTH_TOKEN) {
      const body = String(init?.body ?? "")
      if (!body.includes("code_verifier=") || !body.includes("grant_type=authorization_code")) {
        return Response.json({ error: "missing_code_verifier" })
      }
      return Response.json({ access_token: "ya29.test_token" })
    }
    if (url === GOOGLE_OAUTH_USERINFO) {
      return Response.json({
        sub: "107834588031326048827",
        email: emails.google ?? "octocat@gmail.com",
        email_verified: true,
        name: "The Octocat",
        picture: "https://lh3.example/octocat",
      })
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
    googleClientId: "test-google-client-id",
    googleClientSecret: "test-google-client-secret",
    googleRedirectUri: googleRedirect,
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

describe("google auth", () => {
  test("builds a Google authorize URL with PKCE and the account picker", async () => {
    const auth = configured()
    const started = await auth.start("browser", "google")
    const url = new URL(started.authorizeUrl)
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth")
    expect(url.searchParams.get("client_id")).toBe("test-google-client-id")
    expect(url.searchParams.get("redirect_uri")).toBe(googleRedirect)
    expect(url.searchParams.get("scope")).toBe("openid email profile")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("prompt")).toBe("select_account")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("code_challenge")?.length).toBeGreaterThan(20)
    expect(url.searchParams.get("state")).toBe(started.state)
    expect(started.redirectUri).toBe(googleRedirect)
    expect(started.status.providers).toEqual({ github: true, google: true })
  })

  test("defaults the Google redirect to the public URL callback path", async () => {
    const auth = configured({ googleRedirectUri: undefined, publicUrl: "https://control.example/omnia/" })
    expect(auth.redirectUri("google")).toBe(googleRedirect)
    const started = await auth.start("browser", "google")
    expect(started.redirectUri).toBe(googleRedirect)
  })

  test("honors OMNIA_GOOGLE_REDIRECT_URI when no option is set", async () => {
    process.env.OMNIA_GOOGLE_REDIRECT_URI = googleRedirect
    const auth = configured({ googleRedirectUri: undefined })
    expect(auth.redirectUri("google")).toBe(googleRedirect)
  })

  test("requires a configured Google client", async () => {
    const auth = configured({ googleClientId: "" })
    await expect(auth.start("browser", "google")).rejects.toThrow(/Google OAuth is not configured/)
    expect(auth.status().providers).toEqual({ github: true, google: false })
  })

  test("completes a Google flow with the subject as the profile id", async () => {
    const file = tempFile()
    const auth = configured({ file })
    const started = await auth.start("browser", "google")
    const result = await auth.completeCallback(started.state, "test-code")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.profile.id).toBe("107834588031326048827")
    expect(result.profile.provider).toBe("google")
    expect(result.profile.login).toBe("octocat")
    expect(result.profile.email).toBe("octocat@gmail.com")
    expect(result.profile.avatarUrl).toBe("https://lh3.example/octocat")

    // A string id must survive a restart: it is the key entitlements bill to.
    const restored = new GitHubAuth({ file })
    expect(restored.status().profile?.id).toBe("107834588031326048827")
    expect(restored.status().profile?.provider).toBe("google")
    expect(restored.clientTokenProfile(result.clientToken)?.id).toBe("107834588031326048827")
  })

  test("refuses Google when the email is already connected to GitHub", async () => {
    const file = tempFile()
    const auth = configured({ file })
    const github = await auth.start("browser", "github")
    expect((await auth.completeCallback(github.state, "test-code")).ok).toBe(true)

    // The Google account shares the address the GitHub account already owns.
    const sharing = configured({ file, fetchImpl: fakeFetch({ google: "octocat@github.com" }) })
    const google = await sharing.start("browser", "google")
    const result = await sharing.completeCallback(google.state, "test-code")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.message).toContain("already connected to a GitHub account")
    // Nothing replaced the GitHub session, so the plan and runs stay attached
    // to the profile id that GitHub signed in with.
    expect(sharing.status().profile?.provider).toBe("github")
    expect(sharing.status().profile?.id).toBe(583231)
    // The app is told to stop waiting instead of polling until it times out.
    expect(sharing.poll(google.state)).toEqual({ authenticated: false, failure: result.message })
  })

  test("refuses GitHub when the email is already connected to Google", async () => {
    const file = tempFile()
    const auth = configured({ file })
    const google = await auth.start("browser", "google")
    expect((await auth.completeCallback(google.state, "test-code")).ok).toBe(true)

    const sharing = configured({ file, fetchImpl: fakeFetch({ github: "octocat@gmail.com" }) })
    const github = await sharing.start("browser", "github")
    const result = await sharing.completeCallback(github.state, "test-code")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.message).toContain("already connected to a Google account")
    expect(sharing.status().profile?.provider).toBe("google")
  })

  test("keeps refusing after sign-out", async () => {
    const file = tempFile()
    const auth = configured({ file })
    const github = await auth.start("browser", "github")
    expect((await auth.completeCallback(github.state, "test-code")).ok).toBe(true)
    await auth.logout()
    expect(auth.status().authenticated).toBe(false)

    // Signing out clears the session but not which provider owns the address.
    const sharing = configured({ file, fetchImpl: fakeFetch({ google: "octocat@github.com" }) })
    const google = await sharing.start("browser", "google")
    const result = await sharing.completeCallback(google.state, "test-code")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(409)
    expect(sharing.status().authenticated).toBe(false)
  })

  test("protects an email stored before the ledger existed", async () => {
    const file = tempFile()
    writeFileSync(
      file,
      JSON.stringify({
        profile: { id: 583231, login: "octocat", provider: "github", email: "Octocat@GitHub.com" },
        token: "gho_old_token",
        signedInAt: 1,
      }),
    )
    // Matching is case-insensitive: providers do not agree on casing.
    const sharing = configured({ file, fetchImpl: fakeFetch({ google: "octocat@github.com" }) })
    const google = await sharing.start("browser", "google")
    const result = await sharing.completeCallback(google.state, "test-code")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(409)
  })

  test("allows the same provider to sign in again", async () => {
    const file = tempFile()
    const auth = configured({ file })
    const first = await auth.start("browser", "github")
    expect((await auth.completeCallback(first.state, "test-code")).ok).toBe(true)
    const second = await auth.start("browser", "github")
    expect((await auth.completeCallback(second.state, "test-code")).ok).toBe(true)
    expect(auth.status().profile?.provider).toBe("github")
  })

  test("a later GitHub sign-in replaces the Google session", async () => {
    const auth = configured()
    const google = await auth.start("browser", "google")
    await auth.completeCallback(google.state, "test-code")
    const github = await auth.start("browser", "github")
    await auth.completeCallback(github.state, "test-code")
    expect(auth.status().profile?.provider).toBe("github")
    expect(auth.status().profile?.login).toBe("octocat")
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
