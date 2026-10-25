// The enterprise control plane's HTTP surface.
//
// It is mounted before the bearer-authenticated Omnia API because it has its own
// credential: an HttpOnly session cookie for the console, a per-user client
// token for shipped clients, and a SCIM bearer for provisioning. The generic
// server token never reaches this module, and no enterprise route is reachable
// with it.
//
// Public routes are an exhaustive list in `handlePublic`. Anything not on it
// requires a session before the body is read.

import { createHash } from "node:crypto"
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, extname, join, normalize, resolve, sep } from "node:path"
import type { IncomingMessage, ServerResponse } from "node:http"
import { licensedPlan, verifyLicense } from "./license"
import { byKey, insights, isUsageWindow, usageInWindow } from "./metrics"
import { ClientReleaseFarm, artifactPath, enrollmentBundle } from "./releases"
import {
  EnterpriseStore,
  EnterpriseStoreError,
  LicenseRequiredError,
  openEnterpriseStore,
  sanitizeText,
  slugify,
} from "./store"
import {
  CAPABILITIES,
  PLATFORMS,
  capabilitiesOf,
  type Capability,
  type ClientDistribution,
  type ClientRelease,
  type EnterpriseGroup,
  type EnterpriseSession,
  type EnterpriseUser,
  type NetworkMode,
  type Platform,
  type Role,
} from "./types"

const API_ROOT = "/v1/enterprise"
const COOKIE = "omnia_enterprise"
const BODY_LIMIT = 1 * 1024 * 1024
const LOGIN_WINDOW_MS = 5 * 60 * 1000
const LOGIN_WINDOW_LIMIT = 30
const ASSET_MAX_BYTES = 512 * 1024
const ASSET_LIMIT = 24
const ASSET_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
}
const ASSET_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml" }
const ASSET_NAME = /^(?:logo|icon|background)-[a-f0-9]{32}\.(?:png|jpg|webp|svg)$/

export interface EnterpriseRuntimeOptions {
  readonly file: string
  readonly uiDir?: string
  /** Empty is legal for a LAN-only deployment; URLs then follow the request host. */
  readonly publicUrl: string
  readonly orgName?: string
  readonly adminEmail?: string
  readonly licensePublicKey?: string
  readonly version: string
  readonly now?: () => number
  readonly trustProxy?: boolean
  readonly devOrigins?: readonly string[]
  /** `lan` answers from whatever address the client used; `public` pins publicUrl. */
  readonly mode?: NetworkMode
  /** Source checkout used by the build farm. Discovered when omitted. */
  readonly buildRoot?: string
  /** Set false to serve manifests and enrollment bundles only. */
  readonly build?: boolean
}

export class EnterpriseRuntime {
  readonly store: EnterpriseStore
  readonly publicUrl: string
  readonly version: string
  private readonly mode: NetworkMode
  private readonly uiDir: string | undefined
  private readonly licensePublicKey: string | undefined
  private readonly now: () => number
  private readonly trustProxy: boolean
  private readonly devOrigins: readonly string[]
  private readonly loginAttempts = new Map<string, { count: number; resetAt: number }>()
  private readonly assetsDir: string
  private readonly releasesDir: string
  private readonly farm: ClientReleaseFarm
  private readonly buildEnabled: boolean

  constructor(options: EnterpriseRuntimeOptions) {
    this.store = openEnterpriseStore({
      file: options.file,
      ...(options.orgName === undefined ? {} : { orgName: options.orgName }),
      ...(options.adminEmail === undefined ? {} : { adminEmail: options.adminEmail }),
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    this.publicUrl = options.publicUrl.replace(/\/+$/, "")
    this.mode = options.mode ?? "public"
    this.version = options.version
    this.uiDir = options.uiDir
    this.licensePublicKey = options.licensePublicKey
    this.now = options.now ?? Date.now
    this.trustProxy = options.trustProxy === true
    this.devOrigins = (options.devOrigins ?? []).map((origin) => origin.replace(/\/+$/, ""))
    // Branding files live beside the store so a backup of the data directory
    // carries the console's own assets too.
    this.assetsDir = join(dirname(options.file), "assets")
    // Installers live beside the store as well, so a tenant restore includes
    // exactly the builds its manifest advertises.
    this.releasesDir = join(dirname(options.file), "releases")
    this.buildEnabled = options.build !== false
    this.farm = new ClientReleaseFarm({
      store: this.store,
      outputDir: this.releasesDir,
      ...(options.buildRoot === undefined ? {} : { root: options.buildRoot }),
    })
    // Retention is enforced at start-up, so an idle deployment still ages out
    // usage and audit records instead of holding them forever.
    this.store.prune(this.now())
  }

  /** Verify a client enrollment token. The server uses this as an extra bearer. */
  isClientToken(token: string): boolean {
    return this.store.verifySession(token, "client") !== undefined
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      await this.serveConsole(request, response, url)
      return true
    }
    if (url.pathname !== API_ROOT && !url.pathname.startsWith(`${API_ROOT}/`)) return false
    if (!this.originAllowed(request)) {
      json(response, 403, { ok: false, error: "This origin is not allowed to call the enterprise console." })
      return true
    }
    await this.api(request, response, url)
    return true
  }

  // ── HTTP plumbing ────────────────────────────────────────────────────────

  private async api(request: IncomingMessage, response: ServerResponse, url: URL) {
    const route = url.pathname.slice(API_ROOT.length).replace(/\/+$/, "") || "/"
    const segments = route.split("/").filter(Boolean)
    const method = request.method ?? "GET"
    const ip = this.clientIp(request)
    const userAgent = typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined
    const meta = { ...(userAgent === undefined ? {} : { userAgent }), ip }

    try {
      if (segments[0] === "public") {
        if (await this.handlePublic(request, response, segments.slice(1), method, url, meta)) return
        json(response, 404, { ok: false, error: "Unknown public route." })
        return
      }
      if (segments[0] === "scim" && segments[1] === "v2") {
        await this.handleScim(request, response, segments.slice(2), method, url)
        return
      }

      const session = this.authorize(request)
      if (session === undefined) {
        json(response, 401, { ok: false, code: "unauthenticated", error: "Sign in to the enterprise console." })
        return
      }
      const user = session.user

      if (method === "GET" && segments.length === 1 && segments[0] === "assets") {
        this.require(user, response, "org:read")
        json(response, 200, { ok: true, assets: this.listAssets() })
        return true
      }
      if (method === "DELETE" && segments.length === 2 && segments[0] === "assets") {
        this.require(user, response, "org:write")
        this.requireCsrf(request, response)
        const name = segments[1]!
        if (!ASSET_NAME.test(name)) {
          json(response, 404, { ok: false, error: "Unknown asset." })
          return true
        }
        const usedBy = this.store.distributions().find((distribution) =>
          [distribution.branding.logoUrl, distribution.branding.iconUrl].some((url) => url?.endsWith(`/assets/${name}`)),
        )
        if (usedBy !== undefined) {
          json(response, 409, { ok: false, error: `This asset is used by ${usedBy.name}. Point that build at another image first.` })
          return true
        }
        const file = join(this.assetsDir, name)
        if (!existsSync(file)) {
          json(response, 404, { ok: false, error: "Unknown asset." })
          return true
        }
        unlinkSync(file)
        this.store.appendAudit({ action: "org.asset_deleted", actorId: user.id, actorEmail: user.email, target: name })
        json(response, 200, { ok: true })
        return true
      }
      if (method === "POST" && segments.length === 1 && segments[0] === "assets") {
        this.require(user, response, "org:write")
        this.requireCsrf(request, response)
        const body = await readJson(request, response)
        if (body === undefined) return true
        const uploaded = this.saveAsset(body)
        if ("error" in uploaded) {
          json(response, 400, { ok: false, error: uploaded.error })
          return true
        }
        this.store.appendAudit({
          action: "org.asset_uploaded",
          actorId: user.id,
          actorEmail: user.email,
          target: uploaded.name,
          metadata: { bytes: uploaded.bytes },
        })
        json(response, 200, { ok: true, url: `${this.publicUrl}${API_ROOT}/public/assets/${uploaded.name}` })
        return true
      }

      if (method === "GET" && segments[0] === "session") {
        json(response, 200, {
          ok: true,
          user: publicUser(user),
          capabilities: capabilitiesOf(user.role),
          organization: publicOrganization(this.store, this.licensePublicKey),
          session: { kind: session.session.kind, expiresAt: session.session.expiresAt },
        })
        return
      }
      if (method === "POST" && segments[0] === "logout") {
        this.store.revokeSession(this.cookieToken(request) ?? bearer(request) ?? "")
        this.store.appendAudit({
          action: "user.logout",
          actorId: user.id,
          actorEmail: user.email,
          ...meta,
        })
        response.setHeader("set-cookie", clearCookie(this.secure()))
        json(response, 200, { ok: true })
        return
      }
      if (method === "POST" && segments[0] === "password") {
        const body = await readJson(request, response)
        if (body === undefined) return
        if (typeof body.currentPassword !== "string" || typeof body.newPassword !== "string") {
          json(response, 400, { ok: false, error: "The current and new password are required." })
          return
        }
        this.requireCsrf(request, response)
        await this.store.changePassword(user.id, body.currentPassword, body.newPassword)
        const created = this.store.createSession(user.id, "admin", meta)
        response.setHeader("set-cookie", sessionCookie(created.token, this.secure()))
        json(response, 200, { ok: true })
        return
      }

      if (method === "GET" && segments.length === 1 && segments[0] === "summary") {
        this.require(user, response, "org:read")
        const days = Number(url.searchParams.get("days") ?? "30")
        json(response, 200, { ok: true, summary: this.store.summary(isUsageWindow(days) ? days : 30) })
        return
      }

      if (segments[0] === "org") {
        if (method === "GET") {
          this.require(user, response, "org:read")
          json(response, 200, { ok: true, organization: this.orgForConsole() })
          return
        }
        if (method === "PATCH") {
          this.require(user, response, "org:write")
          this.requireCsrf(request, response)
          this.store.assertLicensed()
          const body = await readJson(request, response)
          if (body === undefined) return
          const organization = this.store.updateOrganization(
            {
              ...(typeof body.name === "string" ? { name: body.name } : {}),
              ...(typeof body.supportEmail === "string" ? { supportEmail: body.supportEmail } : {}),
              ...(typeof body.website === "string" ? { website: body.website } : {}),
              ...(typeof body.logoUrl === "string" ? { logoUrl: body.logoUrl } : {}),
              ...(typeof body.region === "string" ? { region: body.region } : {}),
              ...(record(body.branding) === undefined
                ? {}
                : { branding: body.branding as Partial<import("./types").Branding> }),
              ...(record(body.integrations) === undefined
                ? {}
                : { integrations: body.integrations as Partial<import("./types").Integrations> }),
            },
            user.id,
          )
          json(response, 200, { ok: true, organization: this.redactOrganization(organization) })
          return
        }
      }

      if (segments[0] === "policies") {
        if (method === "GET") {
          this.require(user, response, "policies:read")
          json(response, 200, { ok: true, policies: this.store.policies() })
          return
        }
        if (method === "PUT") {
          this.require(user, response, "policies:write")
          this.requireCsrf(request, response)
          const body = await readJson(request, response)
          if (body === undefined) return
          json(response, 200, { ok: true, policies: this.store.updatePolicies(body, user.id) })
          return
        }
      }

      if (segments[0] === "users") {
        if (await this.handleUsers(request, response, segments.slice(1), method, url, user, meta)) return
      }

      if (segments[0] === "invites") {
        if (method === "GET" && segments.length === 1) {
          this.require(user, response, "users:read")
          json(response, 200, { ok: true, invites: this.store.invites() })
          return
        }
        if (method === "DELETE" && segments.length === 2) {
          this.require(user, response, "users:write")
          this.requireCsrf(request, response)
          this.store.revokeInvite(segments[1]!, user.id)
          json(response, 200, { ok: true })
          return
        }
      }

      if (segments[0] === "groups") {
        if (await this.handleGroups(request, response, segments.slice(1), method, user)) return
      }

      if (segments[0] === "distributions") {
        if (await this.handleDistributions(request, response, segments.slice(1), method, user)) return
      }

      if (segments[0] === "usage") {
        this.require(user, response, "usage:read")
        if (method === "GET" && segments.length === 1) {
          json(response, 200, { ok: true, ...this.usageView(url) })
          return
        }
        if (method === "GET" && segments[1] === "insights") {
          json(response, 200, { ok: true, ...this.usageInsights(url) })
          return
        }
        if (method === "GET" && segments[1] === "export") {
          this.require(user, response, "audit:export")
          this.store.appendAudit({ action: "export.downloaded", actorId: user.id, actorEmail: user.email, target: "usage.csv", ...meta })
          const rows = this.store.usage()
          const csv = toCsv(
            ["timestamp", "user", "model", "provider", "input_tokens", "output_tokens", "cost_usd", "tool", "computer_id", "session_id"],
            rows.map((event) => [
              new Date(event.at).toISOString(),
              this.userLabel(event.userId),
              event.model,
              event.provider ?? "",
              event.inputTokens,
              event.outputTokens,
              event.costUsd,
              event.tool ?? "",
              event.computerId ?? "",
              event.sessionId ?? "",
            ]),
          )
          text(response, 200, csv, "text/csv; charset=utf-8", "usage.csv")
          return
        }
      }

      if (segments[0] === "audit") {
        this.require(user, response, "audit:read")
        if (method === "GET" && segments.length === 1) {
          const limit = Number(url.searchParams.get("limit") ?? "100")
          const before = Number(url.searchParams.get("before") ?? "0")
          const action = url.searchParams.get("action") ?? undefined
          const events = this.store.audit(Number.isFinite(limit) ? limit : 100, before > 0 ? before : undefined, action)
          json(response, 200, { ok: true, events, total: this.store.auditAll().length })
          return
        }
        if (method === "GET" && segments[1] === "export") {
          this.require(user, response, "audit:export")
          this.store.appendAudit({ action: "export.downloaded", actorId: user.id, actorEmail: user.email, target: "audit.csv", ...meta })
          const csv = toCsv(
            ["timestamp", "action", "actor", "target", "ip", "metadata"],
            this.store.auditAll().map((event) => [
              new Date(event.at).toISOString(),
              event.action,
              event.actorEmail ?? event.actorId ?? "",
              event.target ?? "",
              event.ip ?? "",
              event.metadata === undefined ? "" : JSON.stringify(event.metadata),
            ]),
          )
          text(response, 200, csv, "text/csv; charset=utf-8", "audit.csv")
          return
        }
      }

      if (segments[0] === "license") {
        if (method === "GET" && segments.length === 1) {
          this.require(user, response, "license:read")
          json(response, 200, { ok: true, license: this.licenseView() })
          return
        }
        if (method === "PUT" && segments.length === 1) {
          this.require(user, response, "license:write")
          this.requireCsrf(request, response)
          const body = await readJson(request, response)
          if (body === undefined) return
          if (typeof body.token !== "string") {
            json(response, 400, { ok: false, error: "A license token is required." })
            return
          }
          if (this.licensePublicKey === undefined || this.licensePublicKey.trim().length === 0) {
            json(response, 400, {
              ok: false,
              error: "No license public key is configured. Set OMNIA_ENTERPRISE_LICENSE_PUBLIC_KEY and restart.",
            })
            return
          }
          const result = verifyLicense(body.token, this.licensePublicKey, this.now())
          this.store.setLicense(body.token, result.claims, result.error, user.id)
          json(response, result.valid ? 200 : 400, {
            ok: result.valid,
            ...(result.valid ? {} : { error: result.error }),
            license: this.licenseView(),
          })
          return
        }
      }

      if (segments[0] === "integrations") {
        if (method === "GET") {
          this.require(user, response, "integrations:read")
          json(response, 200, { ok: true, integrations: this.store.organization().integrations })
          return
        }
        if (method === "PUT") {
          this.require(user, response, "integrations:write")
          this.requireCsrf(request, response)
          const body = await readJson(request, response)
          if (body === undefined) return
          const organization = this.store.updateOrganization(
            { integrations: body as Partial<import("./types").Integrations> },
            user.id,
          )
          json(response, 200, { ok: true, integrations: organization.integrations })
          return
        }
      }

      if (segments[0] === "scim" && segments[1] === "token" && method === "POST") {
        this.require(user, response, "scim:write")
        this.requireCsrf(request, response)
        const token = this.store.rotateScimToken(user.id)
        json(response, 200, { ok: true, token, baseUrl: `${this.publicUrl}${API_ROOT}/scim/v2` })
        return
      }

      json(response, 404, { ok: false, error: "Unknown enterprise route." })
    } catch (error) {
      if (response.headersSent) return
      if (error instanceof LicenseRequiredError) {
        json(response, 402, { ok: false, code: "license_required", error: error.message })
        return
      }
      if (error instanceof EnterpriseStoreError) {
        json(response, 400, { ok: false, error: error.message })
        return
      }
      console.error("enterprise request failed", error instanceof Error ? error.message : error)
      json(response, 500, { ok: false, error: "The enterprise console request failed." })
    }
  }

  // ── Public routes ────────────────────────────────────────────────────────

  private async handlePublic(
    request: IncomingMessage,
    response: ServerResponse,
    segments: string[],
    method: string,
    url: URL,
    meta: { userAgent?: string; ip?: string },
  ): Promise<boolean> {
    if (method === "GET" && segments.length === 1 && segments[0] === "config") {
      const org = this.store.organization()
      json(response, 200, {
        ok: true,
        version: this.version,
        setupRequired: this.store.setupRequired(),
        organization: { name: org.name, slug: org.slug },
        branding: org.branding,
        plan: this.store.plan(),
        trialEndsAt: org.trialEndsAt,
        licenseValid: org.license.claims !== undefined && org.license.error === undefined,
      })
      return true
    }
    if (method === "GET" && segments.length === 2 && segments[0] === "assets") {
      const name = segments[1]!
      if (!ASSET_NAME.test(name)) {
        json(response, 404, { ok: false, error: "Unknown asset." })
        return true
      }
      const file = join(this.assetsDir, name)
      if (!existsSync(file)) {
        json(response, 404, { ok: false, error: "Unknown asset." })
        return true
      }
      const body = readFileSync(file)
      response.writeHead(200, {
        "content-type": ASSET_MIME[name.slice(name.lastIndexOf(".") + 1)] ?? "application/octet-stream",
        "content-length": String(body.byteLength),
        "cache-control": "public, max-age=31536000, immutable",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
        "x-content-type-options": "nosniff",
      })
      response.end(request.method === "HEAD" ? undefined : body)
      return true
    }
    if (method === "GET" && segments.length === 1 && segments[0] === "health") {
      json(response, 200, { ok: true, version: this.version, setupRequired: this.store.setupRequired(), plan: this.store.plan() })
      return true
    }

    if (method === "POST" && segments.length === 1 && segments[0] === "setup") {
      const body = await readJson(request, response)
      if (body === undefined) return true
      if (typeof body.token !== "string" || typeof body.email !== "string" || typeof body.password !== "string") {
        json(response, 400, { ok: false, error: "The setup token, email and password are required." })
        return true
      }
      const result = await this.store.setup({
        token: body.token,
        email: body.email,
        name: typeof body.name === "string" ? body.name : "",
        password: body.password,
      })
      response.setHeader("set-cookie", sessionCookie(result.token, this.secure()))
      json(response, 200, {
        ok: true,
        user: publicUser(result.user),
        capabilities: capabilitiesOf(result.user.role),
        organization: publicOrganization(this.store, this.licensePublicKey),
        session: { kind: "admin", expiresAt: result.session.expiresAt },
      })
      return true
    }

    if (method === "POST" && segments.length === 1 && segments[0] === "login") {
      if (!this.allowLogin(meta.ip ?? "unknown")) {
        json(response, 429, { ok: false, error: "Too many sign-in attempts. Try again in a few minutes." })
        return true
      }
      const body = await readJson(request, response)
      if (body === undefined) return true
      if (typeof body.email !== "string" || typeof body.password !== "string") {
        json(response, 400, { ok: false, error: "An email address and password are required." })
        return true
      }
      const result = await this.store.login(body.email, body.password, "admin", meta)
      if (!result.ok || result.user === undefined || result.token === undefined || result.session === undefined) {
        json(response, 401, { ok: false, error: result.reason ?? "Sign-in failed." })
        return true
      }
      response.setHeader("set-cookie", sessionCookie(result.token, this.secure()))
      json(response, 200, {
        ok: true,
        user: publicUser(result.user),
        capabilities: capabilitiesOf(result.user.role),
        organization: publicOrganization(this.store, this.licensePublicKey),
        session: { kind: "admin", expiresAt: result.session.expiresAt },
      })
      return true
    }

    if (method === "POST" && segments.length === 1 && segments[0] === "invite") {
      const body = await readJson(request, response)
      if (body === undefined) return true
      if (typeof body.token !== "string" || typeof body.password !== "string") {
        json(response, 400, { ok: false, error: "The invitation token and a password are required." })
        return true
      }
      const result = await this.store.acceptInvite(body.token, body.password, typeof body.name === "string" ? body.name : undefined)
      response.setHeader("set-cookie", sessionCookie(result.token, this.secure()))
      json(response, 200, {
        ok: true,
        user: publicUser(result.user),
        capabilities: capabilitiesOf(result.user.role),
        organization: publicOrganization(this.store, this.licensePublicKey),
        session: { kind: "admin", expiresAt: result.session.expiresAt },
      })
      return true
    }

    if (segments[0] === "client" && segments[1] !== undefined) {
      const distribution = this.store.distribution(segments[1])
      if (distribution === undefined || distribution.status !== "published") {
        json(response, 404, { ok: false, error: "This distribution is not published." })
        return true
      }
      // In LAN mode the answer follows the address the client actually reached,
      // so a device on the office network never receives a loopback or public
      // URL it cannot resolve.
      const baseUrl = this.baseUrl(request)
      if (method === "GET" && segments[2] === "manifest" && segments.length === 3) {
        json(response, 200, { ok: true, manifest: this.store.manifest(distribution, baseUrl) })
        return true
      }
      // One address an updater can poll for everything that decides whether a
      // client should move: the version it should be on, the channel rules the
      // admin set, and the artifact for its own platform.
      if (method === "GET" && segments[2] === "update" && segments.length === 3) {
        const manifest = this.store.manifest(distribution, baseUrl)
        json(response, 200, {
          ok: true,
          update: {
            version: manifest.version,
            ...(manifest.publishedAt === undefined ? {} : { publishedAt: manifest.publishedAt }),
            ...manifest.update,
            installers: manifest.deployment.installers,
          },
        })
        return true
      }
      if (method === "POST" && segments[2] === "login" && segments.length === 3) {
        if (!this.allowLogin(meta.ip ?? "unknown")) {
          json(response, 429, { ok: false, error: "Too many sign-in attempts. Try again in a few minutes." })
          return true
        }
        const body = await readJson(request, response)
        if (body === undefined) return true
        const identifier = typeof body.identifier === "string" ? body.identifier : typeof body.email === "string" ? body.email : undefined
        if (identifier === undefined || typeof body.password !== "string") {
          json(response, 400, { ok: false, error: "An email address or employee ID and a password are required." })
          return true
        }
        const domain = identifier.includes("@") ? identifier.split("@")[1]?.toLowerCase() : undefined
        if (
          distribution.auth.allowedEmailDomains.length > 0 &&
          (domain === undefined || !distribution.auth.allowedEmailDomains.map((entry) => entry.toLowerCase()).includes(domain))
        ) {
          json(response, 403, { ok: false, error: "This distribution only accepts approved email domains." })
          return true
        }
        const result = await this.store.login(identifier, body.password, "client", meta, distribution.auth.sessionHours)
        if (!result.ok || result.token === undefined || result.user === undefined) {
          this.store.appendAudit({ action: "client.login_failed", target: distribution.slug, ...meta })
          json(response, 401, { ok: false, error: result.reason ?? "Sign-in failed." })
          return true
        }
        this.store.appendAudit({
          action: "client.login",
          actorId: result.user.id,
          actorEmail: result.user.email,
          target: distribution.slug,
          ...meta,
        })
        json(response, 200, {
          ok: true,
          token: result.token,
          expiresAt: this.now() + distribution.auth.sessionHours * 60 * 60 * 1000,
          user: publicUser(result.user),
          manifest: this.store.manifest(distribution, baseUrl),
        })
        return true
      }
      if (method === "POST" && segments[2] === "usage" && segments.length === 3) {
        const token = bearer(request)
        const session = token === undefined ? undefined : this.store.verifySession(token, "client")
        if (session === undefined) {
          json(response, 401, { ok: false, error: "A client token is required." })
          return true
        }
        const body = await readJson(request, response)
        if (body === undefined) return true
        const events = Array.isArray(body.events) ? body.events.slice(0, 100) : []
        let accepted = 0
        for (const entry of events) {
          if (typeof entry !== "object" || entry === null) continue
          const record = entry as Record<string, unknown>
          this.store.appendUsage({
            userId: session.user.id,
            model: typeof record.model === "string" ? record.model : "unknown",
            ...(typeof record.provider === "string" ? { provider: record.provider } : {}),
            inputTokens: number(record.inputTokens),
            outputTokens: number(record.outputTokens),
            costUsd: number(record.costUsd),
            ...(typeof record.durationMs === "number" && record.durationMs > 0 ? { durationMs: Math.floor(record.durationMs) } : {}),
            ...(typeof record.tool === "string" ? { tool: record.tool } : {}),
            ...(typeof record.computerId === "string" ? { computerId: record.computerId } : {}),
            ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
            distributionId: distribution.id,
          })
          accepted += 1
        }
        json(response, 200, { ok: true, accepted })
        return true
      }
      if ((method === "GET" || method === "HEAD") && segments[2] === "download" && segments.length === 4) {
        const platform = segments[3]!
        if (!(distribution.deployment.platforms as readonly string[]).includes(platform)) {
          json(response, 404, { ok: false, error: "This distribution is not built for that platform." })
          return true
        }
        // A built installer wins over the enrollment fallback: the manifest
        // already tells clients which of the two this URL serves. Both are
        // audit records so a public deployment can trace what left the server.
        const release = this.store.releaseFor(distribution, platform as Platform)
        const file = release === undefined ? undefined : artifactPath(this.releasesDir, release)
        if (release !== undefined && file !== undefined && existsSync(file)) {
          const info = statSync(file)
          this.store.appendAudit({
            action: "client.download",
            target: distribution.slug,
            ...meta,
            metadata: { platform, artifact: "installer", version: distribution.version, bytes: info.size },
          })
          response.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": String(info.size),
            "content-disposition": `attachment; filename="${(release.filename ?? "installer").replace(/[^A-Za-z0-9._-]/g, "_")}"`,
            "x-omnia-artifact": "installer",
            "x-omnia-sha256": release.sha256 ?? "",
            "cache-control": "private, max-age=0, must-revalidate",
          })
          if (method === "HEAD") {
            response.end()
            return true
          }
          await new Promise<void>((done) => {
            const stream = createReadStream(file)
            stream.on("error", () => {
              response.destroy()
              done()
            })
            stream.on("end", done)
            stream.pipe(response)
          })
          return true
        }
        // No installer yet: build it instead of quietly handing back an
        // enrollment file. Operators paste this URL into MDM and email, and a
        // download link that is not a package is the wrong answer.
        const build = this.installerBuild(distribution, platform as Platform, baseUrl)
        if (build.state === "building") {
          // The page refreshes every few seconds, so only the request that
          // starts the build is audited; polling for progress is not a download.
          if (build.started === true) {
            this.store.appendAudit({
              action: "client.download",
              target: distribution.slug,
              ...meta,
              metadata: { platform, artifact: "building", version: distribution.version },
            })
          }
          response.setHeader("x-omnia-artifact", "building")
          response.setHeader("retry-after", "3")
          if (method === "HEAD") {
            response.writeHead(202, { "cache-control": "no-store" })
            response.end()
            return true
          }
          htmlResponse(response, 202, buildingPage(distribution.name, platform, build.release, this.now()))
          return true
        }
        if (build.state === "failed") {
          this.store.appendAudit({
            action: "client.download",
            target: distribution.slug,
            ...meta,
            metadata: { platform, artifact: "failed", version: distribution.version },
          })
          response.setHeader("x-omnia-artifact", "failed")
          if (method === "HEAD") {
            response.writeHead(502, { "cache-control": "no-store" })
            response.end()
            return true
          }
          htmlResponse(response, 502, failedBuildPage(distribution.name, platform, build.reason))
          return true
        }
        const bundle = enrollmentBundle(distribution, platform as Platform, baseUrl, this.now())
        this.store.appendAudit({
          action: "client.download",
          target: distribution.slug,
          ...meta,
          metadata: { platform, artifact: "enrollment", version: distribution.version },
        })
        response.setHeader("x-omnia-artifact", "enrollment")
        text(
          response,
          200,
          JSON.stringify(bundle, null, 2),
          "application/json; charset=utf-8",
          `${distribution.slug}-${platform}-${distribution.version}.enrollment.json`,
        )
        return true
      }
    }
    return false
  }

  // ── Users, groups, distributions ─────────────────────────────────────────

  /**
   * Start the missing installer for a download request. Returns why no build
   * can run so the caller can fall back to the enrollment bundle only when the
   * host genuinely cannot package that platform.
   */
  private installerBuild(
    distribution: ClientDistribution,
    platform: Platform,
    baseUrl: string,
  ):
    | { state: "building"; release?: ClientRelease; started?: boolean }
    | { state: "failed"; reason: string }
    | { state: "unavailable"; reason: string } {
    if (!this.buildEnabled) {
      return { state: "unavailable", reason: "Client builds are disabled on this deployment." }
    }
    const status = this.farm.status()
    const target = status.targets.find((entry) => entry.platform === platform)
    if (status.host.ready !== true || target === undefined || !target.supported) {
      return {
        state: "unavailable",
        reason: target?.reason ?? status.host.reason ?? "This host cannot build that platform.",
      }
    }
    const releases = this.store
      .releases(distribution.id)
      .filter((entry) => entry.platform === platform && entry.version === distribution.version)
    const active = releases.find((entry) => entry.status === "queued" || entry.status === "building")
    if (active !== undefined) return { state: "building", release: active }
    const last = releases.sort((left, right) => right.startedAt - left.startedAt)[0]
    // A failed build is not retried on every page refresh: that would loop a
    // broken toolchain. The console's Rebuild button is the explicit retry.
    if (last?.status === "failed") {
      return { state: "failed", reason: last.error ?? "The last build for this platform failed." }
    }
    const started = this.farm.start(distribution, [platform], undefined, baseUrl)[0]
    if (started?.error !== undefined) return { state: "unavailable", reason: started.error }
    return { state: "building", started: true, ...(started?.release === undefined ? {} : { release: started.release }) }
  }

  private async handleUsers(
    request: IncomingMessage,
    response: ServerResponse,
    segments: string[],
    method: string,
    url: URL,
    actor: EnterpriseUser,
    meta: { userAgent?: string; ip?: string },
  ): Promise<boolean> {
    if (method === "GET" && segments.length === 0) {
      this.require(actor, response, "users:read")
      const query = (url.searchParams.get("query") ?? "").toLowerCase()
      const status = url.searchParams.get("status")
      const role = url.searchParams.get("role")
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? "100")))
      const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0"))
      const filtered = this.store.users().filter((user) => {
        if (status !== null && status.length > 0 && user.status !== status) return false
        if (role !== null && role.length > 0 && user.role !== role) return false
        if (query.length === 0) return true
        return (
          user.email.includes(query) ||
          user.name.toLowerCase().includes(query) ||
          (user.employeeId ?? "").toLowerCase().includes(query) ||
          (user.department ?? "").toLowerCase().includes(query)
        )
      })
      json(response, 200, { ok: true, users: filtered.slice(offset, offset + limit).map(publicUser), total: filtered.length })
      return true
    }
    if (method === "POST" && segments[0] === "invite") {
      this.require(actor, response, "users:invite")
      this.requireCsrf(request, response)
      const body = await readJson(request, response)
      if (body === undefined) return true
      const email = typeof body.email === "string" ? body.email : ""
      const role = isRole(body.role) ? body.role : "member"
      if (role === "owner" && actor.role !== "owner") {
        json(response, 403, { ok: false, error: "Only an owner can invite another owner." })
        return true
      }
      const groupIds = Array.isArray(body.groupIds) ? body.groupIds.filter((id): id is string => typeof id === "string") : []
      const result = this.store.invite({
        email,
        name: typeof body.name === "string" ? body.name : "",
        role,
        groupIds,
        createdBy: actor.id,
      })
      json(response, 200, {
        ok: true,
        invite: result.invite,
        token: result.token,
        url: `${this.publicUrl}/admin/#/invite?token=${encodeURIComponent(result.token)}`,
      })
      return true
    }
    if (method === "POST" && segments.length === 0) {
      this.require(actor, response, "users:write")
      this.requireCsrf(request, response)
      const body = await readJson(request, response)
      if (body === undefined) return true
      if (typeof body.email !== "string" || typeof body.name !== "string") {
        json(response, 400, { ok: false, error: "A name and email are required." })
        return true
      }
      const role = isRole(body.role) ? body.role : "member"
      if (role === "owner" && actor.role !== "owner") {
        json(response, 403, { ok: false, error: "Only an owner can create another owner." })
        return true
      }
      const user = await this.store.createUser({
        email: body.email,
        name: body.name,
        role,
        ...(typeof body.employeeId === "string" ? { employeeId: body.employeeId } : {}),
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(typeof body.department === "string" ? { department: body.department } : {}),
        ...(typeof body.password === "string" ? { password: body.password } : {}),
        ...(Array.isArray(body.groupIds) ? { groupIds: body.groupIds.filter((id): id is string => typeof id === "string") } : {}),
        createdBy: actor.id,
      })
      json(response, 200, { ok: true, user: publicUser(user) })
      return true
    }
    if (segments.length === 1 && segments[0] !== undefined) {
      const target = this.store.user(segments[0])
      if (target === undefined) {
        json(response, 404, { ok: false, error: "Unknown user." })
        return true
      }
      if (method === "PATCH") {
        this.require(actor, response, "users:write")
        this.requireCsrf(request, response)
        const body = await readJson(request, response)
        if (body === undefined) return true
        if (isRole(body.role) && body.role === "owner" && actor.role !== "owner") {
          json(response, 403, { ok: false, error: "Only an owner can grant ownership." })
          return true
        }
        const updated = this.store.updateUser(
          target.id,
          {
            ...(typeof body.name === "string" ? { name: body.name } : {}),
            ...(isRole(body.role) ? { role: body.role } : {}),
            ...(body.status === "active" || body.status === "suspended" ? { status: body.status } : {}),
            ...(Array.isArray(body.groupIds) ? { groupIds: body.groupIds.filter((id): id is string => typeof id === "string") } : {}),
            ...(typeof body.employeeId === "string" ? { employeeId: body.employeeId } : {}),
            ...(typeof body.title === "string" ? { title: body.title } : {}),
            ...(typeof body.department === "string" ? { department: body.department } : {}),
            ...(typeof body.mfaEnabled === "boolean" ? { mfaEnabled: body.mfaEnabled } : {}),
          },
          actor.id,
        )
        json(response, 200, { ok: true, user: publicUser(updated) })
        return true
      }
      if (method === "DELETE") {
        this.require(actor, response, "users:write")
        this.requireCsrf(request, response)
        if (target.id === actor.id) {
          json(response, 400, { ok: false, error: "You cannot delete your own account." })
          return true
        }
        this.store.deleteUser(target.id, actor.id)
        json(response, 200, { ok: true })
        return true
      }
      if (method === "POST" && segments[1] === "reset") {
        this.require(actor, response, "users:write")
        this.requireCsrf(request, response)
        const result = this.store.createResetToken(target.id, actor.id)
        json(response, 200, {
          ok: true,
          token: result.token,
          url: `${this.publicUrl}/admin/#/invite?token=${encodeURIComponent(result.token)}`,
        })
        return true
      }
    }
    return false
  }

  private async handleGroups(
    request: IncomingMessage,
    response: ServerResponse,
    segments: string[],
    method: string,
    actor: EnterpriseUser,
  ): Promise<boolean> {
    if (method === "GET" && segments.length === 0) {
      this.require(actor, response, "groups:read")
      json(response, 200, { ok: true, groups: this.store.groups() })
      return true
    }
    if (method === "POST" && segments.length === 0) {
      this.require(actor, response, "groups:write")
      this.requireCsrf(request, response)
      const body = await readJson(request, response)
      if (body === undefined) return true
      const group = this.store.createGroup({
        name: typeof body.name === "string" ? body.name : "",
        ...(typeof body.description === "string" ? { description: body.description } : {}),
        ...(isRole(body.role) && body.role !== "owner" ? { role: body.role } : {}),
        ...(Array.isArray(body.modelAllowlist) ? { modelAllowlist: body.modelAllowlist.filter((m): m is string => typeof m === "string") } : {}),
        ...(typeof body.monthlyTokenLimit === "number" ? { monthlyTokenLimit: body.monthlyTokenLimit } : {}),
        ...(typeof body.monthlySpendLimitUsd === "number" ? { monthlySpendLimitUsd: body.monthlySpendLimitUsd } : {}),
        ...(typeof body.maxComputers === "number" ? { maxComputers: body.maxComputers } : {}),
        actorId: actor.id,
      })
      json(response, 200, { ok: true, group })
      return true
    }
    if (segments.length === 1 && segments[0] !== undefined) {
      if (method === "PATCH") {
        this.require(actor, response, "groups:write")
        this.requireCsrf(request, response)
        const body = await readJson(request, response)
        if (body === undefined) return true
        const group = this.store.updateGroup(
          segments[0],
          {
            ...(typeof body.name === "string" ? { name: body.name } : {}),
            ...(typeof body.description === "string" ? { description: body.description } : {}),
            ...(isRole(body.role) && body.role !== "owner" ? { role: body.role } : {}),
            ...(Array.isArray(body.modelAllowlist)
              ? { modelAllowlist: body.modelAllowlist.filter((m): m is string => typeof m === "string") }
              : {}),
            ...(typeof body.monthlyTokenLimit === "number" ? { monthlyTokenLimit: body.monthlyTokenLimit } : {}),
            ...(typeof body.monthlySpendLimitUsd === "number" ? { monthlySpendLimitUsd: body.monthlySpendLimitUsd } : {}),
            ...(typeof body.maxComputers === "number" ? { maxComputers: body.maxComputers } : {}),
          },
          actor.id,
        )
        json(response, 200, { ok: true, group })
        return true
      }
      if (method === "DELETE") {
        this.require(actor, response, "groups:write")
        this.requireCsrf(request, response)
        this.store.deleteGroup(segments[0], actor.id)
        json(response, 200, { ok: true })
        return true
      }
    }
    return false
  }

  private async handleDistributions(
    request: IncomingMessage,
    response: ServerResponse,
    segments: string[],
    method: string,
    actor: EnterpriseUser,
  ): Promise<boolean> {
    if (method === "GET" && segments.length === 0) {
      this.require(actor, response, "distributions:read")
      json(response, 200, { ok: true, distributions: this.store.distributions() })
      return true
    }
    if (method === "POST" && segments.length === 0) {
      this.require(actor, response, "distributions:write")
      this.requireCsrf(request, response)
      const body = await readJson(request, response)
      if (body === undefined) return true
      const distribution = this.store.createDistribution({
        name: typeof body.name === "string" ? body.name : "",
        ...(typeof body.slug === "string" ? { slug: body.slug } : {}),
        ...(typeof body.description === "string" ? { description: body.description } : {}),
        actorId: actor.id,
      })
      json(response, 200, { ok: true, distribution })
      return true
    }
    if (segments[0] !== undefined) {
      const distribution = this.store.distribution(segments[0])
      if (distribution === undefined) {
        json(response, 404, { ok: false, error: "Unknown distribution." })
        return true
      }
      if (method === "GET" && segments.length === 1) {
        this.require(actor, response, "distributions:read")
        json(response, 200, { ok: true, distribution, manifest: this.store.manifest(distribution, this.baseUrl(request)) })
        return true
      }
      if (method === "PATCH" && segments.length === 1) {
        this.require(actor, response, "distributions:write")
        this.requireCsrf(request, response)
        const body = await readJson(request, response)
        if (body === undefined) return true
        const updated = this.store.updateDistribution(
          distribution.id,
          {
            ...(typeof body.name === "string" ? { name: body.name } : {}),
            ...(typeof body.slug === "string" ? { slug: body.slug } : {}),
            ...(typeof body.description === "string" ? { description: body.description } : {}),
            ...(record(body.branding) === undefined ? {} : { branding: body.branding as ClientDistribution["branding"] }),
            ...(record(body.auth) === undefined ? {} : { auth: body.auth as ClientDistribution["auth"] }),
            ...(record(body.features) === undefined ? {} : { features: body.features as ClientDistribution["features"] }),
            ...(record(body.permissions) === undefined
              ? {}
              : { permissions: body.permissions as ClientDistribution["permissions"] }),
            ...(record(body.experience) === undefined ? {} : { experience: body.experience as ClientDistribution["experience"] }),
            ...(record(body.limits) === undefined ? {} : { limits: body.limits as ClientDistribution["limits"] }),
            ...(record(body.models) === undefined ? {} : { models: body.models as ClientDistribution["models"] }),
            ...(record(body.telemetry) === undefined ? {} : { telemetry: body.telemetry as ClientDistribution["telemetry"] }),
            ...(record(body.update) === undefined ? {} : { update: body.update as ClientDistribution["update"] }),
            ...(record(body.deployment) === undefined ? {} : { deployment: body.deployment as ClientDistribution["deployment"] }),
            ...(typeof body.releaseNotes === "string" ? { releaseNotes: body.releaseNotes } : {}),
          },
          actor.id,
        )
        json(response, 200, { ok: true, distribution: updated })
        return true
      }
      if (method === "DELETE" && segments.length === 1) {
        this.require(actor, response, "distributions:write")
        this.requireCsrf(request, response)
        this.store.deleteDistribution(distribution.id, actor.id)
        json(response, 200, { ok: true })
        return true
      }
      if (method === "POST" && segments[1] === "publish") {
        this.require(actor, response, "distributions:publish")
        this.requireCsrf(request, response)
        const body = await readJson(request, response)
        if (body === undefined) return true
        const version = typeof body.version === "string" ? body.version : distribution.version
        const published = this.store.publishDistribution(
          distribution.id,
          version,
          typeof body.releaseNotes === "string" ? body.releaseNotes : distribution.releaseNotes,
          actor.id,
        )
        json(response, 200, { ok: true, distribution: published, manifest: this.store.manifest(published, this.baseUrl(request)) })
        return true
      }
      if (method === "POST" && segments[1] === "duplicate") {
        this.require(actor, response, "distributions:write")
        this.requireCsrf(request, response)
        const duplicated = this.store.duplicateDistribution(distribution.id, actor.id)
        json(response, 200, { ok: true, distribution: duplicated })
        return true
      }
      if (method === "GET" && segments[1] === "manifest") {
        this.require(actor, response, "distributions:read")
        json(response, 200, { ok: true, manifest: this.store.manifest(distribution, this.baseUrl(request)) })
        return true
      }
      if (segments[1] === "releases" && segments[2] === undefined) {
        if (method === "GET") {
          this.require(actor, response, "distributions:read")
          const status = this.farm.status()
          json(response, 200, {
            ok: true,
            build: this.buildEnabled,
            releases: this.store.releases(distribution.id),
            host: status.host,
            targets: status.targets,
          })
          return true
        }
        if (method === "POST") {
          this.require(actor, response, "distributions:write")
          this.requireCsrf(request, response)
          if (!this.buildEnabled) {
            json(response, 403, { ok: false, error: "Client builds are disabled on this deployment." })
            return true
          }
          const body = await readJson(request, response)
          if (body === undefined) return true
          const requested = Array.isArray(body.platforms) ? body.platforms : distribution.deployment.platforms
          const platforms = [...new Set(requested.filter((value): value is Platform =>
            typeof value === "string" && (PLATFORMS as readonly string[]).includes(value),
          ))]
          if (platforms.length === 0) {
            json(response, 400, { ok: false, error: "Choose at least one platform to build." })
            return true
          }
          const results = this.farm.start(distribution, platforms, actor.id, this.baseUrl(request))
          json(response, 202, {
            ok: true,
            releases: results.map((result) => result.release),
            errors: results.flatMap((result) => (result.error === undefined ? [] : [result.error])),
          })
          return true
        }
      }
      if (method === "GET" && segments[1] === "releases" && segments[2] !== undefined) {
        this.require(actor, response, "distributions:read")
        const release = this.store.release(segments[2])
        if (release === undefined || release.distributionId !== distribution.id) {
          json(response, 404, { ok: false, error: "Unknown build." })
          return true
        }
        const file = artifactPath(this.releasesDir, release)
        json(response, 200, {
          ok: true,
          release,
          artifact: file !== undefined && existsSync(file) ? `/v1/enterprise/public/client/${distribution.slug}/download/${release.platform}` : undefined,
        })
        return true
      }
    }
    return false
  }

  // ── SCIM 2.0 ─────────────────────────────────────────────────────────────

  private async handleScim(
    request: IncomingMessage,
    response: ServerResponse,
    segments: string[],
    method: string,
    url: URL,
  ) {
    const token = bearer(request)
    if (!this.store.verifyScimToken(token)) {
      json(response, 401, { schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], detail: "Invalid SCIM bearer token.", status: "401" })
      return
    }
    if (method === "GET" && segments[0] === "ServiceProviderConfig") {
      json(response, 200, {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
        patch: { supported: true },
        bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
        filter: { supported: true, maxResults: 200 },
        changePassword: { supported: false },
        sort: { supported: false },
        etag: { supported: false },
      })
      return
    }
    if (method === "GET" && segments[0] === "Users") {
      const filter = url.searchParams.get("filter") ?? ""
      const match = /(?:userName|externalId)\s+eq\s+"([^"]+)"/i.exec(filter)
      const startIndex = Math.max(1, Number(url.searchParams.get("startIndex") ?? "1"))
      const count = Math.min(200, Math.max(0, Number(url.searchParams.get("count") ?? "100")))
      const users = this.store
        .users()
        .filter((user) => (match === null ? true : user.email === match[1]?.toLowerCase() || user.externalId === match[1]))
      const page = users.slice(startIndex - 1, startIndex - 1 + count)
      json(response, 200, {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
        totalResults: users.length,
        startIndex,
        itemsPerPage: page.length,
        Resources: page.map(scimUser),
      })
      return
    }
    if (method === "GET" && segments[0] === "Users" && segments[1] !== undefined) {
      const user = this.store.user(segments[1])
      if (user === undefined) {
        json(response, 404, { schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], detail: "User not found.", status: "404" })
        return
      }
      json(response, 200, scimUser(user))
      return
    }
    if (method === "POST" && segments[0] === "Users") {
      const body = await readJson(request, response)
      if (body === undefined) return
      const userName = typeof body.userName === "string" ? body.userName : ""
      const name = record(body.name)
      const formatted =
        name === undefined
          ? ""
          : typeof name.formatted === "string"
            ? name.formatted
            : [name.givenName, name.familyName].filter((part): part is string => typeof part === "string").join(" ")
      if (userName.trim().length === 0) {
        json(response, 400, { schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], detail: "A user needs a userName.", status: "400" })
        return
      }
      if (this.store.users().some((user) => user.email === userName.trim().toLowerCase())) {
        json(response, 409, {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
          scimType: "uniqueness",
          detail: "A user with that userName already exists.",
          status: "409",
        })
        return
      }
      const user = await this.store.createUser({
        email: userName,
        name: formatted || userName,
        role: "member",
        ...(typeof body.externalId === "string" ? { externalId: body.externalId } : {}),
        ...(typeof body.active === "boolean" && !body.active ? { status: "suspended" } : {}),
      })
      this.store.appendAudit({ action: "scim.user_created", target: user.email })
      json(response, 201, scimUser(user))
      return
    }
    if (method === "PATCH" && segments[0] === "Users" && segments[1] !== undefined) {
      const body = await readJson(request, response)
      if (body === undefined) return
      const user = this.store.user(segments[1])
      if (user === undefined) {
        json(response, 404, { schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], detail: "User not found.", status: "404" })
        return
      }
      const operations = Array.isArray(body.Operations) ? body.Operations : []
      const patch: { status?: "active" | "suspended"; name?: string; title?: string; department?: string } = {}
      let name: { formatted?: string; givenName?: string; familyName?: string } = {}
      let emailChange: string | undefined
      for (const operation of operations) {
        if (!record(operation)) continue
        const path = typeof operation.path === "string" ? operation.path.toLowerCase() : ""
        const value = operation.value
        const valueRecord = record(value)
        if (path === "active" && typeof value === "boolean") patch.status = value ? "active" : "suspended"
        if (path === "name.formatted" && typeof value === "string") name.formatted = value
        if (path === "name.givenname" && typeof value === "string") name.givenName = value
        if (path === "name.familyname" && typeof value === "string") name.familyName = value
        if (path === "title" && typeof value === "string") patch.title = value
        if (path === "department" && typeof value === "string") patch.department = value
        // The local account's address is its identity everywhere in the store,
        // so a rename is refused instead of half-applied. Directories learn the
        // resource id and use that afterwards.
        if (path === "username" && typeof value === "string") emailChange = value
        if (path === "emails" && Array.isArray(value)) {
          const primary = value.map(record).find((entry) => entry !== undefined && (entry.primary === true || entry.type === "work"))
          if (primary !== undefined && typeof primary.value === "string") emailChange = primary.value
        }
        if (path === "" && valueRecord !== undefined) {
          if (typeof valueRecord.active === "boolean") patch.status = valueRecord.active ? "active" : "suspended"
          if (typeof valueRecord.userName === "string") emailChange = valueRecord.userName
          if (typeof valueRecord.title === "string") patch.title = valueRecord.title
          if (typeof valueRecord.department === "string") patch.department = valueRecord.department
          const nameRecord = record(valueRecord.name)
          if (nameRecord !== undefined) {
            if (typeof nameRecord.formatted === "string") name.formatted = nameRecord.formatted
            if (typeof nameRecord.givenName === "string") name.givenName = nameRecord.givenName
            if (typeof nameRecord.familyName === "string") name.familyName = nameRecord.familyName
          }
          if (Array.isArray(valueRecord.emails)) {
            const primary = valueRecord.emails.map(record).find((entry) => entry !== undefined && entry.primary === true)
            if (primary !== undefined && typeof primary.value === "string") emailChange = primary.value
          }
        }
      }
      if (emailChange !== undefined && emailChange.trim().toLowerCase() !== user.email) {
        json(response, 400, {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
          scimType: "mutability",
          detail: "The sign-in address cannot be changed here. Create the resource with the new address and deactivate this one.",
          status: "400",
        })
        return
      }
      const composed = [name.givenName, name.familyName].filter((part): part is string => part !== undefined).join(" ")
      const resolved = name.formatted ?? (composed.length > 0 ? composed : undefined)
      const updated = this.store.updateUser(user.id, { ...patch, ...(resolved === undefined ? {} : { name: resolved }) })
      this.store.appendAudit({ action: "scim.user_updated", target: user.email })
      json(response, 200, scimUser(updated))
      return
    }
    if (method === "DELETE" && segments[0] === "Users" && segments[1] !== undefined) {
      const user = this.store.user(segments[1])
      if (user !== undefined) this.store.deleteUser(user.id)
      response.writeHead(204)
      response.end()
      return
    }
    if (segments[0] === "Groups") {
      if (method === "GET" && segments[1] === undefined) {
        const filter = url.searchParams.get("filter") ?? ""
        const match = /(?:displayName|externalId)\s+eq\s+"([^"]+)"/i.exec(filter)
        const startIndex = Math.max(1, Number(url.searchParams.get("startIndex") ?? "1"))
        const count = Math.min(200, Math.max(0, Number(url.searchParams.get("count") ?? "100")))
        const groups = this.store
          .groups()
          .filter((group) => match === null || group.name.toLowerCase() === match[1]?.toLowerCase())
        const page = groups.slice(startIndex - 1, startIndex - 1 + count)
        json(response, 200, {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
          totalResults: groups.length,
          startIndex,
          itemsPerPage: page.length,
          Resources: page.map((group) => this.scimGroup(group)),
        })
        return
      }
      if (method === "GET" && segments[1] !== undefined) {
        const group = this.store.groups().find((entry) => entry.id === segments[1])
        if (group === undefined) {
          json(response, 404, { schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], detail: "Group not found.", status: "404" })
          return
        }
        json(response, 200, this.scimGroup(group))
        return
      }
      if (method === "POST" && segments[1] === undefined) {
        const body = await readJson(request, response)
        if (body === undefined) return
        const displayName = typeof body.displayName === "string" ? body.displayName.trim() : ""
        if (displayName.length === 0) {
          json(response, 400, { schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], detail: "A group needs a displayName.", status: "400" })
          return
        }
        if (this.store.groups().some((group) => group.name.toLowerCase() === displayName.toLowerCase())) {
          json(response, 409, { schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], scimType: "uniqueness", detail: "A group with that displayName already exists.", status: "409" })
          return
        }
        const group = this.store.createGroup({ name: displayName })
        this.store.setGroupMembers(group.id, memberIds(body.members))
        this.store.appendAudit({ action: "group.created", target: group.name, metadata: { scim: true } })
        json(response, 201, this.scimGroup(group))
        return
      }
      if ((method === "PATCH" || method === "PUT") && segments[1] !== undefined) {
        const body = await readJson(request, response)
        if (body === undefined) return
        const group = this.store.groups().find((entry) => entry.id === segments[1])
        if (group === undefined) {
          json(response, 404, { schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], detail: "Group not found.", status: "404" })
          return
        }
        // PUT replaces the resource; PATCH applies the operations it names. Both
        // end in the same store call so membership cannot drift between them.
        if (method === "PUT") {
          const displayName = typeof body.displayName === "string" ? body.displayName.trim() : group.name
          if (displayName.length > 0 && displayName !== group.name) this.store.updateGroup(group.id, { name: displayName })
          const updated = this.store.setGroupMembers(group.id, memberIds(body.members))
          json(response, 200, this.scimGroup(updated))
          return
        }
        const operations = Array.isArray(body.Operations) ? body.Operations : []
        let members = this.store.users().filter((user) => user.groupIds.includes(group.id)).map((user) => user.id)
        let name = group.name
        for (const operation of operations) {
          if (!record(operation)) continue
          const path = typeof operation.path === "string" ? operation.path.toLowerCase() : ""
          const value = operation.value
          const action = typeof operation.op === "string" ? operation.op.toLowerCase() : "replace"
          if (path === "displayname" && typeof value === "string" && value.trim().length > 0) name = value.trim()
          const valueRecord = record(value)
          if (path === "" && valueRecord !== undefined) {
            if (typeof valueRecord.displayName === "string" && valueRecord.displayName.trim().length > 0)
              name = valueRecord.displayName.trim()
            if (valueRecord.members !== undefined) members = applyMembers(members, valueRecord.members, action)
          }
          if (path === "members" || path.startsWith("members[")) {
            const scoped = path.startsWith("members[") && typeof operation.path === "string" ? memberSelector(operation.path) : undefined
            const removed = scoped === undefined ? undefined : members.find((id) => this.store.user(id)?.email === scoped || this.store.user(id)?.id === scoped)
            const target = removed === undefined ? value : [{ value: removed }]
            members = applyMembers(members, target, action)
          }
        }
        if (name !== group.name) this.store.updateGroup(group.id, { name })
        const updated = this.store.setGroupMembers(group.id, members)
        json(response, 200, this.scimGroup(updated))
        return
      }
      if (method === "DELETE" && segments[1] !== undefined) {
        const group = this.store.groups().find((entry) => entry.id === segments[1])
        if (group !== undefined) {
          this.store.deleteGroup(group.id)
          this.store.appendAudit({ action: "group.deleted", target: group.name, metadata: { scim: true } })
        }
        response.writeHead(204)
        response.end()
        return
      }
    }
    json(response, 404, { schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], detail: "Unknown SCIM route.", status: "404" })
  }

  private scimGroup(group: EnterpriseGroup) {
    return {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      id: group.id,
      displayName: group.name,
      members: this.store
        .users()
        .filter((user) => user.groupIds.includes(group.id))
        .map((user) => ({ value: user.id, display: user.name, $ref: `${this.publicUrl}${API_ROOT}/scim/v2/Users/${user.id}` })),
      meta: {
        resourceType: "Group",
        created: new Date(group.createdAt).toISOString(),
        lastModified: new Date(group.updatedAt).toISOString(),
      },
    }
  }

  // ── Console assets ───────────────────────────────────────────────────────

  private async serveConsole(request: IncomingMessage, response: ServerResponse, url: URL) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" })
      response.end()
      return
    }
    const relative = url.pathname === "/admin" ? "" : url.pathname.slice("/admin/".length)
    const directory = this.uiDir
    if (directory === undefined) {
      htmlResponse(response, 503, notBuiltPage("The admin console directory is not configured."))
      return
    }
    const root = resolve(directory)
    const candidate = relative.length === 0 || !extname(relative) ? join(root, "index.html") : normalize(join(root, relative))
    if (!(candidate === root || candidate.startsWith(`${root}${sep}`))) {
      response.writeHead(403)
      response.end()
      return
    }
    let file: string
    try {
      file = statSync(candidate).isFile() ? candidate : join(root, "index.html")
    } catch {
      // A missing asset must be a 404. Falling back to index.html here would
      // answer a script request with HTML and turn a build error into a blank
      // console with a syntax error.
      if (extname(relative).length > 0) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
        response.end("Not found")
        return
      }
      file = join(root, "index.html")
    }
    try {
      const body = readFileSync(file)
      const extension = extname(file)
      const headers: Record<string, string> = {
        "content-type": MIME[extension] ?? "application/octet-stream",
        "cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "same-origin",
        "content-security-policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      }
      response.writeHead(200, headers)
      response.end(request.method === "HEAD" ? undefined : body)
    } catch {
      htmlResponse(
        response,
        503,
        notBuiltPage(
          `No admin console build was found in ${directory}. Run \`bun run build\` in packages/omnia-enterprise, then restart the server.`,
        ),
      )
    }
  }

  // ── Guards ───────────────────────────────────────────────────────────────

  private cookieToken(request: IncomingMessage): string | undefined {
    const header = request.headers.cookie
    if (typeof header !== "string") return undefined
    for (const part of header.split(";")) {
      const [name, ...rest] = part.trim().split("=")
      if (name === COOKIE) return decodeURIComponent(rest.join("="))
    }
    return undefined
  }

  private authorize(request: IncomingMessage): { session: EnterpriseSession; user: EnterpriseUser } | undefined {
    const token = this.cookieToken(request) ?? bearer(request)
    if (token === undefined) return undefined
    const result = this.store.verifySession(token, "admin")
    if (result === undefined) return undefined
    const allowlist = this.store.policies().ipAllowlist
    if (allowlist.length > 0 && !allowlist.some((entry) => ipMatches(this.clientIp(request), entry))) return undefined
    return result
  }

  private require(user: EnterpriseUser, response: ServerResponse, capability: Capability): boolean {
    if (this.store.permits(user, capability)) return true
    json(response, 403, { ok: false, error: `Your role (${user.role}) cannot ${capability.replace(":", " ")}.` })
    return false
  }

  private requireCsrf(request: IncomingMessage, response: ServerResponse): boolean {
    if (bearer(request) !== undefined && this.cookieToken(request) === undefined) return true
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined
    const referer = typeof request.headers.referer === "string" ? request.headers.referer : undefined
    let candidate = origin
    if (candidate === undefined && referer !== undefined) {
      try {
        candidate = new URL(referer).origin
      } catch {
        candidate = undefined
      }
    }
    if (candidate !== undefined && this.allowedOrigin(candidate, request)) return true
    json(response, 403, { ok: false, error: "This request did not come from the enterprise console." })
    return false
  }

  private originAllowed(request: IncomingMessage): boolean {
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined
    // No Origin header is a same-origin navigation, curl, or an agent. Session
    // checks still apply; CSRF is checked separately on unsafe methods.
    if (origin === undefined || origin.length === 0) return true
    return this.allowedOrigin(origin, request)
  }

  private allowedOrigin(origin: string, request: IncomingMessage): boolean {
    const normalized = comparableOrigin(origin)
    // A browser's Origin header never carries a path, but publicUrl is the
    // console's full mount (https://host/test1/ent). Comparing the raw strings
    // rejected every browser call once the console stopped sitting at the root.
    if (normalized === comparableOrigin(this.publicUrl)) return true
    if (this.devOrigins.some((entry) => comparableOrigin(entry) === normalized)) return true
    // Browsing the console at localhost when the configured public URL names
    // 127.0.0.1 (or the other way around) is still the same server. Compare the
    // authority the browser actually used, never a caller-supplied body field.
    const forwardedHost = request.headers["x-forwarded-host"]
    const host = this.trustProxy && typeof forwardedHost === "string" ? forwardedHost : request.headers.host
    if (host === undefined) return false
    try {
      return new URL(normalized).host === host.toLowerCase()
    } catch {
      return false
    }
  }

  private allowLogin(ip: string): boolean {
    const at = this.now()
    const entry = this.loginAttempts.get(ip)
    if (entry === undefined || entry.resetAt <= at) {
      this.loginAttempts.set(ip, { count: 1, resetAt: at + LOGIN_WINDOW_MS })
      if (this.loginAttempts.size > 5_000) {
        const oldest = this.loginAttempts.keys().next().value
        if (oldest !== undefined) this.loginAttempts.delete(oldest)
      }
      return true
    }
    entry.count += 1
    return entry.count <= LOGIN_WINDOW_LIMIT
  }

  private clientIp(request: IncomingMessage): string {
    if (this.trustProxy) {
      const forwarded = request.headers["x-forwarded-for"]
      if (typeof forwarded === "string" && forwarded.length > 0) return forwarded.split(",")[0]!.trim()
    }
    return request.socket.remoteAddress ?? "unknown"
  }

  private secure(): boolean {
    return this.publicUrl.startsWith("https://")
  }

  /**
   * The address a client should use for this server. A LAN-only deployment has
   * no meaningful configured origin, so it answers with the authority the
   * request actually arrived on. The Host header is only echoed back inside a
   * JSON body, never used as a redirect target.
   */
  private baseUrl(request: IncomingMessage): string {
    if (this.mode !== "lan") return this.publicUrl
    const forwardedHost = request.headers["x-forwarded-host"]
    const host = this.trustProxy && typeof forwardedHost === "string" ? forwardedHost : request.headers.host
    if (typeof host !== "string" || !/^[A-Za-z0-9.:\[\]-]+$/.test(host)) return this.publicUrl
    const forwardedProto = request.headers["x-forwarded-proto"]
    const proto =
      this.trustProxy && typeof forwardedProto === "string" && forwardedProto.split(",")[0]?.trim() === "https"
        ? "https"
        : "http"
    return `${proto}://${host}`
  }

  private organizationForConsole() {
    return this.redactOrganization(this.store.organization())
  }

  private redactOrganization(org: ReturnType<EnterpriseStore["organization"]>) {
    return {
      ...org,
      smtp:
        org.smtp === undefined
          ? undefined
          : {
              host: org.smtp.host,
              port: org.smtp.port,
              from: org.smtp.from,
              secure: org.smtp.secure,
              username: org.smtp.username,
              passwordSet: org.smtp.password !== undefined && org.smtp.password.length > 0,
            },
      license: {
        ...org.license,
        token: org.license.token === undefined ? undefined : "installed",
      },
    }
  }

  private usageView(url: URL) {
    const requested = Number(url.searchParams.get("days") ?? "30")
    const days = isUsageWindow(requested) ? requested : 30
    const groupByParam = url.searchParams.get("groupBy") ?? "day"
    const groupBy = groupByParam === "user" || groupByParam === "model" || groupByParam === "tool" ? groupByParam : "day"
    const userId = url.searchParams.get("userId") ?? undefined
    const model = url.searchParams.get("model") ?? undefined
    const inWindow = usageInWindow(this.store.usage(), days, this.now()).filter((event) => {
      if (userId !== undefined && event.userId !== userId) return false
      if (model !== undefined && event.model !== model) return false
      return true
    })
    return {
      days,
      groupBy,
      buckets: byKey(inWindow, groupBy, this.store.users()),
      total: {
        requests: inWindow.length,
        inputTokens: inWindow.reduce((sum, event) => sum + event.inputTokens, 0),
        outputTokens: inWindow.reduce((sum, event) => sum + event.outputTokens, 0),
        costUsd: Math.round(inWindow.reduce((sum, event) => sum + event.costUsd, 0) * 1_000_000) / 1_000_000,
      },
      events: inWindow.slice(-200).reverse(),
      models: [...new Set(this.store.usage().map((event) => event.model))].sort(),
      users: this.store.users().map((user) => ({ id: user.id, email: user.email, name: user.name })),
    }
  }

  private listAssets() {
    if (!existsSync(this.assetsDir)) return []
    return readdirSync(this.assetsDir)
      .filter((name) => ASSET_NAME.test(name))
      .flatMap((name) => {
        const info = statSync(join(this.assetsDir, name))
        return [
          {
            name,
            url: `${this.publicUrl}${API_ROOT}/public/assets/${name}`,
            bytes: info.size,
            createdAt: info.mtimeMs,
          },
        ]
      })
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  private saveAsset(body: Record<string, unknown>): { name: string; bytes: number } | { error: string } {
    const kind = body.kind === "icon" || body.kind === "background" ? body.kind : "logo"
    const contentType = typeof body.contentType === "string" ? body.contentType : ""
    const extension = ASSET_TYPES[contentType]
    if (extension === undefined) return { error: "Use a PNG, JPEG, WebP or SVG image." }
    if (typeof body.data !== "string" || body.data.length === 0) return { error: "The image data is empty." }
    const bytes = Buffer.from(body.data.replace(/^data:[^;]+;base64,/, ""), "base64")
    if (bytes.byteLength === 0) return { error: "The image data is empty." }
    if (bytes.byteLength > ASSET_MAX_BYTES) return { error: "Images must be 512 KB or smaller." }
    mkdirSync(this.assetsDir, { recursive: true, mode: 0o700 })
    const existing = readdirSync(this.assetsDir).filter((entry) => ASSET_NAME.test(entry))
    if (existing.length >= ASSET_LIMIT) return { error: "This deployment has reached its branding asset limit. Remove an old file from the data directory first." }
    const name = `${kind}-${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}.${extension}`
    writeFileSync(join(this.assetsDir, name), bytes, { mode: 0o600 })
    return { name, bytes: bytes.byteLength }
  }

  private usageInsights(url: URL) {
    const requested = Number(url.searchParams.get("days") ?? "30")
    const days = isUsageWindow(requested) ? requested : 30
    return insights(this.store.usage(), this.store.users(), days, this.now())
  }

  private userLabel(id: string): string {
    const user = this.store.user(id)
    return user === undefined ? id : user.email
  }

  private licenseView() {
    const org = this.store.organization()
    const plan = licensedPlan(org.license, this.now(), org.trialEndsAt)
    return {
      plan,
      publicKeyConfigured: this.licensePublicKey !== undefined && this.licensePublicKey.trim().length > 0,
      license: {
        ...org.license,
        token: org.license.token === undefined ? undefined : "installed",
      },
      trialEndsAt: org.trialEndsAt,
      seats: this.store.seatUsage(),
    }
  }

  private orgForConsole() {
    return this.organizationForConsole()
  }

}

// ── Helpers ────────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
}

function json(response: ServerResponse, status: number, value: unknown) {
  if (response.headersSent) return
  const body = JSON.stringify(value)
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  })
  response.end(body)
}

function text(response: ServerResponse, status: number, body: string, type: string, filename?: string) {
  if (response.headersSent) return
  response.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...(filename === undefined ? {} : { "content-disposition": `attachment; filename="${filename.replace(/["\\]/g, "")}"` }),
  })
  response.end(body)
}

function htmlResponse(response: ServerResponse, status: number, body: string) {
  if (response.headersSent) return
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  })
  response.end(body)
}

function notBuiltPage(detail: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Omnia Enterprise</title>
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;background:#fafafa;color:#171717;display:grid;place-items:center;height:100vh;margin:0}
main{max-width:34rem;padding:2rem;border:1px solid #e5e5e5;border-radius:12px;background:#fff}
code{background:#f5f5f5;padding:.15rem .35rem;border-radius:4px;font-size:.9em}p{line-height:1.6;color:#525252}</style></head>
<body><main><h1>Enterprise console is not built</h1><p>${escapeHtml(detail)}</p>
<p>The API is running and reachable at <code>/v1/enterprise</code>.</p></main></body></html>`
}

/** Ordered packaging stages; the log lines are the server's own, so they are safe to interpret. */
const BUILD_STEPS = [
  {
    label: "Preparing the toolchain",
    test: (line: string) => line.startsWith("Preparing build dependencies") || line.startsWith("$ bun install"),
  },
  {
    label: "Compiling the desktop app",
    test: (line: string) => line.startsWith("$ bun run build") || line.includes("electron-vite build"),
  },
  {
    label: "Packaging the installer",
    test: (line: string) => line.includes("electron-builder") || line.includes("packaging platform="),
  },
  {
    label: "Finishing the artifact",
    test: (line: string) =>
      line.includes("building block map") || line.includes("building embedded block map") || line.startsWith("Artifact "),
  },
]

/** The furthest stage the build log has reached. -1 means "starting". */
function buildStage(release: ClientRelease | undefined): number {
  let stage = -1
  for (const line of release?.log ?? []) {
    const found = BUILD_STEPS.findIndex((step) => step.test(line))
    if (found > stage) stage = found
  }
  return stage
}

function elapsedLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds % 60}s`
}

function buildingPage(name: string, platform: string, release: ClientRelease | undefined, now: number): string {
  const stage = buildStage(release)
  const steps = BUILD_STEPS.map((step, index) => {
    const state = index < stage ? "done" : index === stage ? "active" : "todo"
    return `<li class="${state}"><span class="dot">${index < stage ? "✓" : ""}</span>${step.label}</li>`
  }).join("")
  const current = stage < 0 ? "Starting the build" : BUILD_STEPS[stage]!.label
  const elapsed = release === undefined ? "just started" : `${elapsedLabel(now - release.startedAt)} elapsed`
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3">
<title>Building the ${escapeHtml(platform)} installer</title>
<style>
body{font-family:ui-sans-serif,system-ui,sans-serif;background:#fafafa;color:#171717;display:grid;place-items:center;min-height:100vh;margin:0;padding:1.5rem;box-sizing:border-box}
main{width:100%;max-width:34rem;padding:2rem;border:1px solid #e5e5e5;border-radius:12px;background:#fff}
h1{font-size:1.15rem;margin:0 0 .5rem}
p{line-height:1.6;color:#525252;margin:.5rem 0}
.meta{display:flex;flex-wrap:wrap;justify-content:space-between;gap:.5rem 1rem;font-size:.8rem;color:#737373;margin:1.35rem 0 .45rem}
.bar{height:6px;border-radius:999px;background:#f0f0f0;overflow:hidden}
.bar span{display:block;height:100%;width:34%;border-radius:999px;background:#2563eb;animation:slide 1.5s ease-in-out infinite}
@keyframes slide{0%{transform:translateX(-100%)}100%{transform:translateX(320%)}}
ol{list-style:none;padding:0;margin:1.25rem 0 0;border-top:1px solid #f0f0f0}
li{display:flex;align-items:center;gap:.6rem;padding:.55rem 0;font-size:.875rem;color:#a3a3a3}
li.done{color:#525252}
li.active{color:#171717;font-weight:600}
.dot{width:16px;height:16px;border-radius:999px;border:1.5px solid #d4d4d4;display:grid;place-items:center;font-size:10px;line-height:1;flex:none}
li.done .dot{background:#2563eb;border-color:#2563eb;color:#fff}
li.active .dot{border-color:#2563eb;border-top-color:transparent;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.hint{margin-top:1.4rem;font-size:.8rem}
</style></head>
<body><main><h1>Building the ${escapeHtml(platform)} installer</h1>
<p>The ${escapeHtml(name)} client was not packaged for this platform yet, so the server started a build. This page refreshes every 3 seconds, and the same URL serves the installer when it finishes.</p>
<div class="meta" role="status"><span>${current}</span><span>${elapsed}</span></div>
<div class="bar" role="progressbar" aria-label="Build in progress"><span></span></div>
<ol>${steps}</ol>
<p class="hint">First builds take a few minutes; the log for every stage is in the console under this client's Installers panel.</p>
</main></body></html>`
}

function failedBuildPage(name: string, platform: string, reason: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Installer build failed</title>
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;background:#fafafa;color:#171717;display:grid;place-items:center;height:100vh;margin:0}
main{max-width:34rem;padding:2rem;border:1px solid #e5e5e5;border-radius:12px;background:#fff}
code{background:#f5f5f5;padding:.15rem .35rem;border-radius:4px;font-size:.9em}p{line-height:1.6;color:#525252}</style></head>
<body><main><h1>Could not build the ${escapeHtml(platform)} installer</h1>
<p>${escapeHtml(name)} could not be packaged on this server.</p>
<p><code>${escapeHtml(reason)}</code></p>
<p>Fix the cause, then use Rebuild in the console. Until then this URL reports the failure instead of an installer.</p></main></body></html>`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    char === "&" ? "&amp;" : char === "<" ? "&lt;" : char === ">" ? "&gt;" : char === '"' ? "&quot;" : "&#39;",
  )
}

/**
 * The part of a URL that identifies an origin, for comparing a browser's
 * Origin header against a configured console URL. `publicUrl` may name the
 * console's mount path; the Origin header never does.
 */
function comparableOrigin(value: string): string {
  try {
    const url = new URL(value)
    // Non-special schemes (oc://renderer) report origin "null"; scheme and
    // authority are still what identifies the caller.
    return url.origin === "null" ? `${url.protocol}//${url.host}` : url.origin
  } catch {
    return value.replace(/\/+$/, "")
  }
}

function bearer(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization ?? ""
  if (!header.toLowerCase().startsWith("bearer ")) return undefined
  const token = header.slice(7).trim()
  return token.length === 0 ? undefined : token
}

function sessionCookie(token: string, secure: boolean): string {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${12 * 60 * 60}${secure ? "; Secure" : ""}`
}

function clearCookie(secure: boolean): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`
}

async function readJson(request: IncomingMessage, response: ServerResponse): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > BODY_LIMIT) {
      json(response, 413, { ok: false, error: "Request body is too large." })
      request.resume()
      return undefined
    }
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      json(response, 400, { ok: false, error: "A JSON object is required." })
      return undefined
    }
    return parsed as Record<string, unknown>
  } catch {
    json(response, 400, { ok: false, error: "The request body is not valid JSON." })
    return undefined
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function isRole(value: unknown): value is Role {
  return typeof value === "string" && ["owner", "admin", "manager", "member", "auditor", "billing"].includes(value)
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
}

/** Exact addresses and dotted prefixes, which is what an admin can reason about. */
function ipMatches(address: string, entry: string): boolean {
  const rule = entry.trim()
  if (rule.length === 0) return false
  if (rule.endsWith(".")) return address.startsWith(rule)
  if (rule.includes("/")) {
    const [network, bits] = rule.split("/")
    if (network === undefined || bits === undefined) return false
    const length = Number(bits)
    if (!Number.isInteger(length) || length < 0 || length > 32) return false
    const toInt = (value: string) => value.split(".").reduce((sum, part) => (sum << 8) + (Number(part) & 255), 0) >>> 0
    const mask = length === 0 ? 0 : (0xffffffff << (32 - length)) >>> 0
    return (toInt(address) & mask) === (toInt(network) & mask)
  }
  return address === rule
}

export function publicUser(user: EnterpriseUser) {
  return {
    id: user.id,
    email: user.email,
    ...(user.employeeId === undefined ? {} : { employeeId: user.employeeId }),
    name: user.name,
    role: user.role,
    status: user.status,
    groupIds: [...user.groupIds],
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    ...(user.lastActiveAt === undefined ? {} : { lastActiveAt: user.lastActiveAt }),
    mfaEnabled: user.mfaEnabled,
    seat: user.seat,
    ...(user.title === undefined ? {} : { title: user.title }),
    ...(user.department === undefined ? {} : { department: user.department }),
    ...(user.externalId === undefined ? {} : { externalId: user.externalId }),
    passwordSet: user.passwordHash !== undefined,
  }
}

function publicOrganization(store: EnterpriseStore, publicKey: string | undefined) {
  const org = store.organization()
  const plan = store.plan()
  return {
    name: org.name,
    slug: org.slug,
    region: org.region,
    plan,
    trialEndsAt: org.trialEndsAt,
    license: {
      valid: org.license.claims !== undefined && org.license.error === undefined,
      plan: org.license.claims?.plan ?? null,
      seats: org.license.claims?.seats ?? 25,
      publicKeyConfigured: publicKey !== undefined && publicKey.trim().length > 0,
      ...(org.license.claims === undefined ? {} : { expiresAt: org.license.claims.expiresAt }),
      ...(org.license.error === undefined ? {} : { error: org.license.error }),
    },
    branding: org.branding,
    policies: org.policies,
  }
}

function memberIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry === "string") return entry.trim().length > 0 ? [entry.trim()] : []
    const member = record(entry)
    return member !== undefined && typeof member.value === "string" && member.value.trim().length > 0
      ? [member.value.trim()]
      : []
  })
}

/** The three PATCH verbs the SCIM spec defines for membership changes. */
function applyMembers(current: readonly string[], value: unknown, action: string): string[] {
  const ids = memberIds(value)
  if (action === "add") return [...new Set([...current, ...ids])]
  if (action === "remove") return current.filter((id) => !ids.includes(id))
  return [...new Set(ids)]
}

function memberSelector(path: string): string | undefined {
  const match = /^members\[(?:value|display)\s+eq\s+"([^"]+)"\]$/i.exec(path.trim())
  return match?.[1]
}

function scimUser(user: EnterpriseUser) {
  const [givenName, ...rest] = user.name.split(" ")
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    id: user.id,
    userName: user.email,
    ...(user.externalId === undefined ? {} : { externalId: user.externalId }),
    name: {
      formatted: user.name,
      givenName: givenName ?? "",
      familyName: rest.join(" "),
    },
    emails: [{ value: user.email, primary: true, type: "work" }],
    active: user.status === "active",
    ...(user.title === undefined ? {} : { title: user.title }),
    ...(user.department === undefined ? {} : { department: user.department }),
    meta: {
      resourceType: "User",
      created: new Date(user.createdAt).toISOString(),
      lastModified: new Date(user.updatedAt).toISOString(),
    },
  }
}

export function toCsv(headers: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n"
}

function csvCell(value: string | number): string {
  const text = String(value)
  if (!/[",\n\r]/.test(text)) return text
  return `"${text.replace(/"/g, '""')}"`
}

export const ENTERPRISE_CAPABILITIES = CAPABILITIES
export { slugify, sanitizeText }
