// The durable enterprise store.
//
// One JSON document, like the other Omnia stores: atomic rename, owner-only
// permissions, symlink-refusing. The difference is what happens on corruption.
// A corrupt chat-channel file is recoverable by reconnecting; a corrupt identity
// store must not silently become "no users", because that would either lock
// everyone out or, worse, re-open bootstrap. So the reader preserves the bytes,
// marks the store unreadable, and refuses to serve.

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { createHash, randomBytes } from "node:crypto"
import { dirname, join } from "node:path"
import { hashPassword, burnPasswordCheck, verifyPassword, passwordProblem } from "./password"
import { licensedPlan } from "./license"
import { activeUsers, byDay, byModel, byTool, byUser, totals, usageInWindow } from "./metrics"
import {
  ENTERPRISE_STATE_VERSION,
  PLATFORMS,
  ROLE_CAPABILITIES,
  absoluteBranding,
  can,
  defaultBranding,
  defaultDistribution,
  defaultExperience,
  defaultPolicies,
  isNetworkMode,
  normalizePermissions,
  type AuditAction,
  type AuditEvent,
  type Capability,
  type ClientAuth,
  type ClientDeployment,
  type ClientDistribution,
  type ClientManifest,
  type ClientRelease,
  type EnterpriseGroup,
  type EnterpriseInvite,
  type EnterpriseSession,
  type EnterpriseState,
  type EnterpriseUser,
  type InstallerLink,
  type LegalBan,
  type LegalBanKind,
  type LegalDecision,
  type OrganizationSettings,
  type Platform,
  type Policies,
  type ReleaseStatus,
  type Role,
  type Summary,
  type UsageEvent,
  type UserStatus,
} from "./types"

const MAX_USERS = 10_000
const MAX_GROUPS = 2_000
const MAX_INVITES = 5_000
const MAX_SESSIONS = 20_000
const MAX_DISTRIBUTIONS = 200
const MAX_RELEASES = 500
const MAX_RELEASE_LOG = 200
const MAX_AUDIT = 20_000
const MAX_USAGE = 100_000
const MAX_LEGAL_BANS = 10_000
const MAX_STRING = 2_048
const SESSION_TOUCH_MS = 60_000
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000
const TRIAL_DAYS = 14
const LOGIN_FAILURE_LIMIT = 8
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000

export class EnterpriseStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EnterpriseStoreError"
  }
}

export class LicenseRequiredError extends EnterpriseStoreError {
  constructor(message = "The trial has ended. Activate a Business or Enterprise license to continue.") {
    super(message)
    this.name = "LicenseRequiredError"
  }
}

export interface EnterpriseStoreOptions {
  readonly file: string
  readonly orgName?: string
  readonly adminEmail?: string
  readonly publicUrl?: string
  readonly now?: () => number
}

export interface SessionMeta {
  readonly userAgent?: string
  readonly ip?: string
}

export interface LoginResult {
  readonly ok: boolean
  readonly user?: EnterpriseUser
  readonly token?: string
  readonly session?: EnterpriseSession
  readonly reason?: string
  readonly retryAfter?: number
}

/**
 * Create or open a store. A missing file is a new deployment: the org is written
 * immediately so `init` can report a real org id. An existing file must parse and
 * carry the expected version.
 */
export function openEnterpriseStore(options: EnterpriseStoreOptions): EnterpriseStore {
  return new EnterpriseStore(options)
}

export class EnterpriseStore {
  readonly file: string
  private readonly now: () => number
  private state: EnterpriseState
  private lastWriteAt: number | undefined
  private writable = true
  /** Mtime of the ban records this process is holding, so a running server
   * notices an operator's `ban`/`unban` without a restart. */
  private legalBansAt = 0

  constructor(options: EnterpriseStoreOptions) {
    this.file = options.file
    this.now = options.now ?? Date.now
    if (existsSync(this.file)) {
      this.state = readState(this.file)
      // Stores written before client experience existed still have to produce a
      // complete manifest. Fill the gap in memory rather than rewriting the
      // file on every read.
      this.state.distributions = this.state.distributions.map((distribution) => ({
        ...distribution,
        experience: { ...defaultExperience(), ...distribution.experience },
        // Deployments written before the LAN/public split are public: they were
        // created with an externally reachable public URL.
        deployment: { ...distribution.deployment, mode: distribution.deployment.mode ?? "public" },
        // Stores written before tool permissions existed derive them from the
        // capability switches, so an already-disabled tool stays denied.
        permissions: normalizePermissions(distribution.permissions, distribution.features),
      }))
      this.state.releases = (this.state.releases ?? []).filter((release) => Array.isArray(release.log))
      // Files written before bans existed have no field at all, and a partially
      // written one may hold shapes this build cannot enforce; both read as none
      // rather than failing every login on an unknown record.
      this.state.legalBans = (this.state.legalBans ?? []).filter(
        (ban) => ban.kind === "account" || ban.kind === "installation",
      )
      this.legalBansAt = mtimeOf(this.file)
      return
    }
    const at = this.now()
    const orgName = sanitizeText(options.orgName ?? "Acme", 120) || "Acme"
    this.state = {
      version: ENTERPRISE_STATE_VERSION,
      organization: {
        id: `org_${randomBytes(8).toString("hex")}`,
        name: orgName,
        slug: slugify(orgName) || "acme",
        region: "self-hosted",
        adminEmail: sanitizeEmail(options.adminEmail ?? "") ?? "admin@example.com",
        createdAt: at,
        updatedAt: at,
        policies: defaultPolicies(),
        branding: defaultBranding(orgName),
        trialStartedAt: at,
        trialEndsAt: at + TRIAL_DAYS * 24 * 60 * 60 * 1000,
        license: {},
        scimEnabled: false,
        integrations: { scimEnabled: false },
      },
      users: [],
      groups: [],
      invites: [],
      sessions: [],
      distributions: [],
      releases: [],
      audit: [],
      usage: [],
      legalBans: [],
    }
    this.save()
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  organization(): OrganizationSettings {
    return structuredClone(this.state.organization)
  }

  users(): EnterpriseUser[] {
    return structuredClone(this.state.users)
  }

  user(id: string): EnterpriseUser | undefined {
    const found = this.state.users.find((user) => user.id === id)
    return found === undefined ? undefined : structuredClone(found)
  }

  groups(): EnterpriseGroup[] {
    return structuredClone(this.state.groups)
  }

  invites(): EnterpriseInvite[] {
    return structuredClone(this.state.invites.filter((invite) => invite.acceptedAt === undefined && invite.revokedAt === undefined))
  }

  distributions(): ClientDistribution[] {
    return structuredClone(this.state.distributions)
  }

  distribution(id: string): ClientDistribution | undefined {
    const found = this.state.distributions.find((entry) => entry.id === id || entry.slug === id)
    return found === undefined ? undefined : structuredClone(found)
  }

  releases(distributionId?: string): ClientRelease[] {
    const found =
      distributionId === undefined
        ? this.state.releases
        : this.state.releases.filter((release) => release.distributionId === distributionId)
    // Newest first: the console shows the current attempt, not the first one.
    return structuredClone(found).sort((left, right) => right.startedAt - left.startedAt)
  }

  release(id: string): ClientRelease | undefined {
    const found = this.state.releases.find((entry) => entry.id === id)
    return found === undefined ? undefined : structuredClone(found)
  }

  /** The ready artifact for a published version, if one was built here. */
  releaseFor(distribution: ClientDistribution, platform: Platform): ClientRelease | undefined {
    // A rebuild of the same version leaves both records behind; the newest one
    // is the file that is actually on disk.
    const found = this.state.releases
      .filter(
        (release) =>
          release.distributionId === distribution.id &&
          release.version === distribution.version &&
          release.platform === platform &&
          release.status === "ready",
      )
      .sort((left, right) => right.startedAt - left.startedAt)[0]
    return found === undefined ? undefined : structuredClone(found)
  }

  policies(): Policies {
    return structuredClone(this.state.organization.policies)
  }

  audit(limit = 100, before?: number, action?: string): AuditEvent[] {
    const filtered = this.state.audit.filter((event) => {
      if (before !== undefined && event.at >= before) return false
      if (action !== undefined && event.action !== action) return false
      return true
    })
    return structuredClone(filtered.slice(-Math.max(1, Math.min(limit, 1_000))).reverse())
  }

  auditAll(): AuditEvent[] {
    return structuredClone(this.state.audit)
  }

  usage(): UsageEvent[] {
    return structuredClone(this.state.usage)
  }

  /**
   * Apply the organization's retention windows to the records it governs.
   *
   * The policy page has always published `data.retentionDays` and
   * `audit.retentionDays`; until this runs they were only words on a form. The
   * prune is bounded by the same caps as ingestion, so a bad clock cannot empty
   * the store, and it only writes when something actually aged out.
   */
  prune(at = this.now()): { usage: number; audit: number } {
    const policies = this.state.organization.policies
    const usageCutoff = at - Math.max(1, policies.data.retentionDays) * 24 * 60 * 60 * 1000
    const auditCutoff = at - Math.max(1, policies.audit.retentionDays) * 24 * 60 * 60 * 1000
    const usage = this.state.usage.filter((event) => event.at >= usageCutoff)
    const audit = this.state.audit.filter((event) => event.at >= auditCutoff)
    const removed = { usage: this.state.usage.length - usage.length, audit: this.state.audit.length - audit.length }
    if (removed.usage === 0 && removed.audit === 0) return removed
    this.state.usage = usage
    this.state.audit = audit
    this.save()
    return removed
  }

  hasOwner(): boolean {
    return this.state.users.some((user) => user.role === "owner" && user.status === "active")
  }

  setupRequired(): boolean {
    return !this.hasOwner()
  }

  writableStore(): boolean {
    return this.writable
  }

  lastWrite(): number | undefined {
    return this.lastWriteAt
  }

  capabilities(user: EnterpriseUser): readonly Capability[] {
    return ROLE_CAPABILITIES[user.role]
  }

  permits(user: EnterpriseUser, capability: Capability): boolean {
    return can(user.role, capability)
  }

  plan() {
    const org = this.state.organization
    return licensedPlan(org.license, this.now(), org.trialEndsAt)
  }

  /** Mutations are refused once the trial ends without a license. Reads stay open. */
  assertLicensed(): void {
    if (this.plan() === "expired") throw new LicenseRequiredError()
  }

  seatUsage(): { used: number; licensed: number; available: number | null } {
    const used = this.state.users.filter((user) => user.seat && user.status !== "suspended").length
    const licensed = this.state.organization.license.claims?.seats ?? 25
    if (this.plan() === "enterprise") {
      // Enterprise contracts are negotiated by seat count but not hard-capped
      // here; the console reports overage instead of blocking work.
      return { used, licensed, available: null }
    }
    // Trials and Business licenses are hard-capped: an invitation must not be
    // the thing that quietly turns 25 seats into 40.
    return { used, licensed, available: Math.max(0, licensed - used) }
  }

  summary(days = 30): Summary {
    const at = this.now()
    const org = this.state.organization
    const events = usageInWindow(this.state.usage, days, at)
    const total = totals(events)
    const plan = this.plan()
    return {
      users: {
        total: this.state.users.length,
        active: this.state.users.filter((user) => user.status === "active").length,
        invited: this.state.users.filter((user) => user.status === "invited").length,
        suspended: this.state.users.filter((user) => user.status === "suspended").length,
      },
      seats: this.seatUsage(),
      distributions: {
        total: this.state.distributions.length,
        published: this.state.distributions.filter((entry) => entry.status === "published").length,
      },
      usage: { ...total, activeUsers: activeUsers(events) },
      spendByDay: byDay(events, days, at),
      usageByModel: byModel(events),
      usageByUser: byUser(events, this.state.users),
      topTools: byTool(events),
      recentAudit: this.audit(8),
      trial: {
        active: plan === "trial",
        endsAt: org.trialEndsAt,
        daysLeft: Math.max(0, Math.ceil((org.trialEndsAt - at) / (24 * 60 * 60 * 1000))),
      },
      license: {
        valid: org.license.claims !== undefined && org.license.error === undefined && org.license.claims.expiresAt > at,
        plan,
        seats: org.license.claims?.seats ?? 25,
        ...(org.license.claims === undefined ? {} : { expiresAt: org.license.claims.expiresAt }),
        ...(org.license.error === undefined ? {} : { error: org.license.error }),
      },
      health: {
        storeWritable: this.writable,
        auditBacklog: this.state.audit.length,
        ...(this.lastWriteAt === undefined ? {} : { lastWriteAt: this.lastWriteAt }),
      },
    }
  }

  // ── Bootstrap and authentication ─────────────────────────────────────────

  /**
   * Create a one-time owner setup token. The raw token is returned exactly once
   * and only its hash is stored. Calling this after setup returns undefined.
   */
  bootstrap(force = false): { token: string; expiresAt: number } | undefined {
    if (this.hasOwner()) return undefined
    const at = this.now()
    // `start` must not silently invalidate the link `init` printed. Only an
    // explicit reset, or a token that has expired, mints a new one.
    if (
      !force &&
      this.state.bootstrapTokenHash !== undefined &&
      this.state.bootstrapExpiresAt !== undefined &&
      this.state.bootstrapExpiresAt > at
    ) {
      return undefined
    }
    const token = `oms_setup_${randomBytes(24).toString("base64url")}`
    this.state.bootstrapTokenHash = hashToken(token)
    this.state.bootstrapExpiresAt = at + BOOTSTRAP_TTL_MS
    this.save()
    return { token, expiresAt: at + BOOTSTRAP_TTL_MS }
  }

  async setup(input: {
    token: string
    email: string
    name: string
    password: string
  }): Promise<{ token: string; session: EnterpriseSession; user: EnterpriseUser }> {
    if (this.hasOwner()) throw new EnterpriseStoreError("This server is already set up.")
    const at = this.now()
    if (this.state.bootstrapTokenHash === undefined) throw new EnterpriseStoreError("No setup token is available.")
    if (this.state.bootstrapExpiresAt === undefined || this.state.bootstrapExpiresAt <= at) {
      throw new EnterpriseStoreError("The setup token has expired. Run `omnia-server init --reset-setup` to issue a new one.")
    }
    if (hashToken(input.token) !== this.state.bootstrapTokenHash) throw new EnterpriseStoreError("The setup token is not valid.")
    const problem = passwordProblem(input.password)
    if (problem !== undefined) throw new EnterpriseStoreError(problem)
    const email = requireEmail(input.email)
    const passwordHash = await hashPassword(input.password)
    if (this.hasOwner() || this.state.bootstrapTokenHash !== hashToken(input.token) ||
      this.state.bootstrapExpiresAt === undefined || this.state.bootstrapExpiresAt <= this.now()) {
      throw new EnterpriseStoreError("The setup token is no longer valid.")
    }
    // Consume the token before anything is written: two concurrent setup calls
    // must not both create an owner.
    this.state.bootstrapTokenHash = undefined
    this.state.bootstrapExpiresAt = undefined
    const user: EnterpriseUser = {
      id: `usr_${randomBytes(8).toString("hex")}`,
      email,
      name: sanitizeText(input.name, 120) || email.split("@")[0]!,
      role: "owner",
      status: "active",
      groupIds: [],
      passwordHash,
      passwordUpdatedAt: at,
      createdAt: at,
      updatedAt: at,
      lastActiveAt: at,
      mfaEnabled: false,
      seat: true,
    }
    this.pushUser(user)
    this.appendAudit({ action: "org.setup", actorId: user.id, actorEmail: user.email, target: email })
    const created = this.createSession(user.id, "admin", {})
    return { token: created.token, session: structuredClone(created.session), user: structuredClone(user) }
  }

  async login(
    identifier: string,
    password: string,
    kind: "admin" | "client" = "admin",
    meta: SessionMeta = {},
    hours?: number,
  ): Promise<LoginResult> {
    const at = this.now()
    let user = this.findByIdentifier(identifier)
    if (user === undefined) {
      await burnPasswordCheck(password)
      this.appendAudit({ action: "user.login_failed", metadata: { identifier: sanitizeText(identifier, 200) } })
      return { ok: false, reason: "The email address or password is incorrect." }
    }
    if (user.status === "suspended") return { ok: false, reason: "This account is suspended. Contact your administrator." }
    // A ban outranks a valid password: the account is refused before the
    // credential is even checked, and the refusal is audited so an appeal can
    // see the attempt.
    const decision = this.legalDecision({ email: user.email })
    if (decision.banned) {
      this.appendAudit({
        action: "legal.login_blocked",
        actorId: user.id,
        actorEmail: user.email,
        ...meta,
      })
      return { ok: false, reason: "This account is banned. Appeal using the address on the ban notice." }
    }
    if (user.status === "invited" || user.passwordHash === undefined) {
      return { ok: false, reason: "This account has not finished setup. Use the invitation link to set a password." }
    }
    if (user.lockedUntil !== undefined && user.lockedUntil > at) {
      return { ok: false, reason: "Too many failed attempts. Try again shortly.", retryAfter: Math.ceil((user.lockedUntil - at) / 1000) }
    }
    const valid = await verifyPassword(password, user.passwordHash)
    // Password verification yields: administrators may suspend, delete or edit
    // the account while it is running. Commit against the current record only.
    const userId = user.id
    const current = this.state.users.find((entry) => entry.id === userId)
    if (current === undefined || current.status !== "active" || current.passwordHash !== user.passwordHash ||
      this.legalDecision({ email: current.email }).banned ||
      (current.lockedUntil !== undefined && current.lockedUntil > this.now())) {
      return { ok: false, reason: "The account changed during sign-in. Try again." }
    }
    user = current
    if (!valid) {
      const failures = (user.failedLogins ?? 0) + 1
      const lockedUntil = failures >= LOGIN_FAILURE_LIMIT ? at + LOGIN_LOCKOUT_MS : undefined
      this.state.users = this.state.users.map((entry) =>
        entry.id === user.id ? { ...entry, failedLogins: failures, ...(lockedUntil === undefined ? {} : { lockedUntil }) } : entry,
      )
      this.appendAudit({ action: "user.login_failed", actorId: user.id, actorEmail: user.email, ...meta })
      return {
        ok: false,
        reason: "The email address or password is incorrect.",
        ...(lockedUntil === undefined ? {} : { retryAfter: Math.ceil(LOGIN_LOCKOUT_MS / 1000) }),
      }
    }
    const updated: EnterpriseUser = {
      ...user,
      status: "active",
      seat: true,
      lastActiveAt: at,
      updatedAt: at,
      failedLogins: 0,
      lockedUntil: undefined,
    }
    this.state.users = this.state.users.map((entry) => (entry.id === user.id ? updated : entry))
    this.appendAudit({ action: "user.login", actorId: user.id, actorEmail: user.email, ...meta })
    const created = this.createSession(user.id, kind, meta, hours)
    return { ok: true, user: structuredClone(updated), token: created.token, session: structuredClone(created.session) }
  }

  createSession(
    userId: string,
    kind: "admin" | "client",
    meta: SessionMeta,
    requestedHours?: number,
  ): { token: string; session: EnterpriseSession } {
    const at = this.now()
    const org = this.state.organization
    const hours = Math.max(1, Math.min(720, requestedHours ?? org.policies.sessionHours))
    const token = `oms_${kind}_${randomBytes(32).toString("base64url")}`
    const session: EnterpriseSession = {
      id: `ses_${randomBytes(8).toString("hex")}`,
      userId,
      kind,
      tokenHash: hashToken(token),
      createdAt: at,
      expiresAt: at + hours * 60 * 60 * 1000,
      lastSeenAt: at,
      ...(meta.userAgent === undefined ? {} : { userAgent: sanitizeText(meta.userAgent, 256) }),
      ...(meta.ip === undefined ? {} : { ip: sanitizeText(meta.ip, 64) }),
    }
    this.state.sessions.push(session)
    this.pruneSessions(at)
    this.save()
    return { token, session: structuredClone(session) }
  }

  verifySession(token: string, kind: "admin" | "client"): { session: EnterpriseSession; user: EnterpriseUser } | undefined {
    if (typeof token !== "string" || token.length < 16 || token.length > 512) return undefined
    const hash = hashToken(token)
    const at = this.now()
    const session = this.state.sessions.find((entry) => entry.tokenHash === hash && entry.kind === kind)
    if (session === undefined) return undefined
    const idleLimit = this.state.organization.policies.idleTimeoutMinutes * 60_000
    if (session.expiresAt <= at || (kind === "admin" && at - session.lastSeenAt > idleLimit)) {
      this.state.sessions = this.state.sessions.filter((entry) => entry.id !== session.id)
      this.save()
      return undefined
    }
    const user = this.state.users.find((entry) => entry.id === session.userId)
    if (user === undefined || user.status !== "active") return undefined
    if (at - session.lastSeenAt > SESSION_TOUCH_MS) {
      session.lastSeenAt = at
      this.save()
    }
    return { session: structuredClone(session), user: structuredClone(user) }
  }

  revokeSession(token: string): boolean {
    const hash = hashToken(token)
    const before = this.state.sessions.length
    this.state.sessions = this.state.sessions.filter((entry) => entry.tokenHash !== hash)
    if (this.state.sessions.length === before) return false
    this.save()
    return true
  }

  revokeUserSessions(userId: string): void {
    this.state.sessions = this.state.sessions.filter((entry) => entry.userId !== userId)
    this.save()
  }

  async changePassword(userId: string, current: string, next: string): Promise<void> {
    const user = this.state.users.find((entry) => entry.id === userId)
    if (user === undefined) throw new EnterpriseStoreError("Unknown user.")
    if (user.passwordHash === undefined) throw new EnterpriseStoreError("This account has no password yet.")
    if (!(await verifyPassword(current, user.passwordHash))) throw new EnterpriseStoreError("The current password is incorrect.")
    const problem = passwordProblem(next)
    if (problem !== undefined) throw new EnterpriseStoreError(problem)
    const hash = await hashPassword(next)
    const at = this.now()
    this.state.users = this.state.users.map((entry) =>
      entry.id === userId ? { ...entry, passwordHash: hash, passwordUpdatedAt: at, updatedAt: at } : entry,
    )
    this.state.sessions = this.state.sessions.filter((entry) => entry.userId !== userId || entry.kind === "client")
    this.save()
    this.appendAudit({ action: "user.password_reset", actorId: userId, target: user.email })
  }

  async resetPassword(userId: string, password: string): Promise<void> {
    const user = this.state.users.find((entry) => entry.id === userId)
    if (user === undefined) throw new EnterpriseStoreError("Unknown user.")
    const problem = passwordProblem(password)
    if (problem !== undefined) throw new EnterpriseStoreError(problem)
    const hash = await hashPassword(password)
    const at = this.now()
    this.state.users = this.state.users.map((entry) =>
      entry.id === userId
        ? { ...entry, passwordHash: hash, passwordUpdatedAt: at, updatedAt: at, status: "active" as const, failedLogins: 0, lockedUntil: undefined }
        : entry,
    )
    this.save()
    this.revokeUserSessions(userId)
    this.appendAudit({ action: "user.password_reset", actorId: userId, target: user.email })
  }

  // ── Users ────────────────────────────────────────────────────────────────

  findByIdentifier(identifier: string): EnterpriseUser | undefined {
    const needle = identifier.trim().toLowerCase()
    if (needle.length === 0) return undefined
    const found = this.state.users.find((user) => user.email === needle || (user.employeeId ?? "").toLowerCase() === needle)
    return found === undefined ? undefined : structuredClone(found)
  }

  invite(input: { email: string; name?: string; role: Role; groupIds?: string[]; createdBy: string }): { invite: EnterpriseInvite; token: string } {
    this.assertLicensed()
    const email = requireEmail(input.email)
    if (this.state.invites.filter((entry) => entry.acceptedAt === undefined && entry.revokedAt === undefined).length >= MAX_INVITES) {
      throw new EnterpriseStoreError("Too many pending invitations.")
    }
    if (this.state.users.some((user) => user.email === email)) throw new EnterpriseStoreError("A user with that email already exists.")
    if (this.state.invites.some((entry) => entry.email === email && entry.acceptedAt === undefined && entry.revokedAt === undefined)) {
      throw new EnterpriseStoreError("That email already has a pending invitation.")
    }
    if (this.seatUsage().available === 0) throw new EnterpriseStoreError("No seats are available. Add seats to your license first.")
    const at = this.now()
    const token = `oms_invite_${randomBytes(24).toString("base64url")}`
    const invite: EnterpriseInvite = {
      id: `inv_${randomBytes(8).toString("hex")}`,
      email,
      role: input.role,
      groupIds: (input.groupIds ?? []).filter((id) => this.state.groups.some((group) => group.id === id)),
      purpose: "invite",
      tokenHash: hashToken(token),
      createdAt: at,
      expiresAt: at + INVITE_TTL_MS,
      createdBy: input.createdBy,
    }
    this.state.invites.push(invite)
    this.state.users.push({
      id: `usr_${randomBytes(8).toString("hex")}`,
      email,
      name: sanitizeText(input.name ?? "", 120) || email.split("@")[0]!,
      role: input.role,
      status: "invited",
      groupIds: invite.groupIds,
      createdAt: at,
      updatedAt: at,
      mfaEnabled: false,
      seat: false,
    })
    this.save()
    this.appendAudit({ action: "user.invited", actorId: input.createdBy, target: email, metadata: { role: input.role } })
    return { invite: structuredClone(invite), token }
  }

  /** A one-time link that lets an existing user choose a new password. */
  createResetToken(userId: string, actorId?: string): { invite: EnterpriseInvite; token: string } {
    this.assertLicensed()
    const user = this.state.users.find((entry) => entry.id === userId)
    if (user === undefined) throw new EnterpriseStoreError("Unknown user.")
    const at = this.now()
    const token = `oms_reset_${randomBytes(24).toString("base64url")}`
    const invite: EnterpriseInvite = {
      id: `inv_${randomBytes(8).toString("hex")}`,
      email: user.email,
      role: user.role,
      groupIds: [...user.groupIds],
      purpose: "reset",
      userId: user.id,
      tokenHash: hashToken(token),
      createdAt: at,
      expiresAt: at + INVITE_TTL_MS,
      createdBy: actorId ?? user.id,
    }
    this.state.invites.push(invite)
    this.save()
    this.appendAudit({ action: "user.password_reset", ...(actorId === undefined ? {} : { actorId }), target: user.email })
    return { invite: structuredClone(invite), token }
  }

  async acceptInvite(
    token: string,
    password: string,
    name?: string,
  ): Promise<{ token: string; session: EnterpriseSession; user: EnterpriseUser }> {
    this.assertLicensed()
    const hash = hashToken(token)
    const at = this.now()
    const invite = this.state.invites.find((entry) => entry.tokenHash === hash)
    if (invite === undefined || invite.acceptedAt !== undefined || invite.revokedAt !== undefined) {
      throw new EnterpriseStoreError("This invitation is not valid.")
    }
    if (invite.expiresAt <= at) throw new EnterpriseStoreError("This invitation has expired.")
    const problem = passwordProblem(password)
    if (problem !== undefined) throw new EnterpriseStoreError(problem)
    if (this.seatUsage().available === 0) throw new EnterpriseStoreError("No seats are available. Ask your administrator to add seats.")
    let user = this.state.users.find((entry) => (invite.userId === undefined ? entry.email === invite.email : entry.id === invite.userId))
    if (user === undefined) throw new EnterpriseStoreError("The invited user no longer exists.")
    const passwordHash = await hashPassword(password)
    this.assertLicensed()
    const currentInvite = this.state.invites.find((entry) => entry.id === invite.id)
    if (currentInvite === undefined || currentInvite.acceptedAt !== undefined || currentInvite.revokedAt !== undefined ||
      currentInvite.expiresAt <= this.now()) throw new EnterpriseStoreError("This invitation is no longer valid.")
    const userId = user.id
    user = this.state.users.find((entry) => entry.id === userId)
    if (user === undefined || user.status === "suspended") throw new EnterpriseStoreError("The invited user is unavailable.")
    if (this.seatUsage().available === 0) throw new EnterpriseStoreError("No seats are available. Ask your administrator to add seats.")
    const updated: EnterpriseUser = {
      ...user,
      name: sanitizeText(name ?? "", 120) || user.name,
      status: "active",
      seat: true,
      passwordHash,
      passwordUpdatedAt: at,
      updatedAt: at,
      lastActiveAt: at,
    }
    this.state.users = this.state.users.map((entry) => (entry.id === user.id ? updated : entry))
    this.state.invites = this.state.invites.map((entry) => (entry.id === invite.id ? { ...entry, acceptedAt: at } : entry))
    if (invite.purpose === "reset") {
      this.state.sessions = this.state.sessions.filter((entry) => entry.userId !== user.id)
    }
    this.save()
    this.appendAudit({ action: "user.created", actorId: user.id, actorEmail: user.email, target: user.email })
    const created = this.createSession(user.id, "admin", {})
    return { token: created.token, session: structuredClone(created.session), user: structuredClone(updated) }
  }

  async createUser(input: {
    email: string
    name: string
    role: Role
    employeeId?: string
    title?: string
    department?: string
    groupIds?: string[]
    externalId?: string
    password?: string
    status?: UserStatus
    createdBy?: string
  }): Promise<EnterpriseUser> {
    this.assertLicensed()
    const email = requireEmail(input.email)
    if (this.state.users.some((user) => user.email === email)) throw new EnterpriseStoreError("A user with that email already exists.")
    if (this.state.users.length >= MAX_USERS) throw new EnterpriseStoreError("Too many users.")
    if (input.password !== undefined) {
      const problem = passwordProblem(input.password)
      if (problem !== undefined) throw new EnterpriseStoreError(problem)
    }
    const passwordHash = input.password === undefined ? undefined : await hashPassword(input.password)
    this.assertLicensed()
    if (this.state.users.some((user) => user.email === email)) throw new EnterpriseStoreError("A user with that email already exists.")
    const at = this.now()
    const user: EnterpriseUser = {
      id: `usr_${randomBytes(8).toString("hex")}`,
      email,
      ...(input.employeeId === undefined ? {} : { employeeId: sanitizeText(input.employeeId, 64) }),
      ...(input.title === undefined ? {} : { title: sanitizeText(input.title, 120) }),
      ...(input.department === undefined ? {} : { department: sanitizeText(input.department, 120) }),
      name: sanitizeText(input.name, 120) || email.split("@")[0]!,
      role: input.role,
      // A directory may create a resource that is already deactivated; that is a
      // suspended account, never an invitation somebody can accept.
      status: input.status ?? (input.password === undefined ? "invited" : "active"),
      groupIds: (input.groupIds ?? []).filter((id) => this.state.groups.some((group) => group.id === id)),
      createdAt: at,
      updatedAt: at,
      mfaEnabled: false,
      seat: input.password !== undefined && input.status !== "suspended",
      ...(passwordHash === undefined ? {} : { passwordHash, passwordUpdatedAt: at }),
      ...(input.externalId === undefined ? {} : { externalId: sanitizeText(input.externalId, 128) }),
    }
    this.pushUser(user)
    this.appendAudit({
      action: "user.created",
      ...(input.createdBy === undefined ? {} : { actorId: input.createdBy }),
      target: email,
    })
    return structuredClone(user)
  }

  updateUser(
    id: string,
    patch: {
      name?: string
      role?: Role
      status?: UserStatus
      groupIds?: string[]
      employeeId?: string
      title?: string
      department?: string
      mfaEnabled?: boolean
    },
    actorId?: string,
  ): EnterpriseUser {
    this.assertLicensed()
    const user = this.state.users.find((entry) => entry.id === id)
    if (user === undefined) throw new EnterpriseStoreError("Unknown user.")
    if (patch.role === "owner" && user.role !== "owner" && !this.hasOwner()) {
      throw new EnterpriseStoreError("Only an owner can grant ownership.")
    }
    if (user.role === "owner" && patch.role !== undefined && patch.role !== "owner" && this.ownerCount() <= 1) {
      throw new EnterpriseStoreError("The organization must keep at least one owner.")
    }
    if (patch.status === "suspended" && user.role === "owner" && this.ownerCount() <= 1) {
      throw new EnterpriseStoreError("The organization must keep at least one active owner.")
    }
    if (patch.status === "active" && user.status === "invited" && user.passwordHash === undefined) {
      throw new EnterpriseStoreError("An invited user must accept their invitation before they can be activated.")
    }
    const at = this.now()
    const updated: EnterpriseUser = {
      ...user,
      ...(patch.name === undefined ? {} : { name: sanitizeText(patch.name, 120) || user.name }),
      ...(patch.role === undefined ? {} : { role: patch.role }),
      ...(patch.status === undefined ? {} : { status: patch.status, seat: patch.status !== "suspended" ? user.seat || patch.status === "active" : user.seat }),
      ...(patch.groupIds === undefined
        ? {}
        : { groupIds: patch.groupIds.filter((groupId) => this.state.groups.some((group) => group.id === groupId)) }),
      ...(patch.employeeId === undefined ? {} : { employeeId: sanitizeText(patch.employeeId, 64) }),
      ...(patch.title === undefined ? {} : { title: sanitizeText(patch.title, 120) }),
      ...(patch.department === undefined ? {} : { department: sanitizeText(patch.department, 120) }),
      ...(patch.mfaEnabled === undefined ? {} : { mfaEnabled: patch.mfaEnabled }),
      updatedAt: at,
    }
    this.state.users = this.state.users.map((entry) => (entry.id === id ? updated : entry))
    if (patch.status === "suspended") this.state.sessions = this.state.sessions.filter((entry) => entry.userId !== id)
    this.save()
    this.appendAudit({
      action: patch.status === "suspended" ? "user.suspended" : patch.status === "active" ? "user.reactivated" : "user.updated",
      ...(actorId === undefined ? {} : { actorId }),
      target: user.email,
      metadata: {
        ...(patch.role === undefined ? {} : { role: patch.role }),
        ...(patch.status === undefined ? {} : { status: patch.status }),
      },
    })
    return structuredClone(updated)
  }

  deleteUser(id: string, actorId?: string): void {
    this.assertLicensed()
    const user = this.state.users.find((entry) => entry.id === id)
    if (user === undefined) throw new EnterpriseStoreError("Unknown user.")
    if (user.role === "owner" && this.ownerCount() <= 1) throw new EnterpriseStoreError("The organization must keep at least one owner.")
    this.state.users = this.state.users.filter((entry) => entry.id !== id)
    this.state.sessions = this.state.sessions.filter((entry) => entry.userId !== id)
    this.state.invites = this.state.invites.filter((entry) => entry.email !== user.email)
    this.save()
    this.appendAudit({ action: "user.deleted", ...(actorId === undefined ? {} : { actorId }), target: user.email })
  }

  revokeInvite(id: string, actorId?: string): void {
    const invite = this.state.invites.find((entry) => entry.id === id)
    if (invite === undefined) throw new EnterpriseStoreError("Unknown invitation.")
    this.state.invites = this.state.invites.map((entry) => (entry.id === id ? { ...entry, revokedAt: this.now() } : entry))
    this.state.users = this.state.users.filter((entry) => !(entry.email === invite.email && entry.status === "invited"))
    this.save()
    this.appendAudit({ action: "user.updated", ...(actorId === undefined ? {} : { actorId }), target: invite.email, metadata: { revoked: true } })
  }

  inviteToken(id: string): string | undefined {
    // The raw token is only available at creation. Rotating a pending invite is
    // the supported recovery path, so this deliberately returns nothing.
    return this.state.invites.some((entry) => entry.id === id) ? undefined : undefined
  }

  // ── Groups ───────────────────────────────────────────────────────────────

  createGroup(input: {
    name: string
    description?: string
    role?: Exclude<Role, "owner">
    modelAllowlist?: string[]
    monthlyTokenLimit?: number
    monthlySpendLimitUsd?: number
    maxComputers?: number
    actorId?: string
  }): EnterpriseGroup {
    this.assertLicensed()
    if (this.state.groups.length >= MAX_GROUPS) throw new EnterpriseStoreError("Too many groups.")
    const at = this.now()
    const group: EnterpriseGroup = {
      id: `grp_${randomBytes(8).toString("hex")}`,
      name: sanitizeText(input.name, 120) || "Team",
      description: sanitizeText(input.description ?? "", 400),
      role: input.role ?? "member",
      createdAt: at,
      updatedAt: at,
      modelAllowlist: (input.modelAllowlist ?? []).map((model) => sanitizeText(model, 160)).filter(Boolean),
      ...(input.monthlyTokenLimit === undefined ? {} : { monthlyTokenLimit: Math.max(0, Math.floor(input.monthlyTokenLimit)) }),
      ...(input.monthlySpendLimitUsd === undefined ? {} : { monthlySpendLimitUsd: Math.max(0, input.monthlySpendLimitUsd) }),
      ...(input.maxComputers === undefined ? {} : { maxComputers: Math.max(1, Math.floor(input.maxComputers)) }),
    }
    this.state.groups.push(group)
    this.save()
    this.appendAudit({ action: "group.created", ...(input.actorId === undefined ? {} : { actorId: input.actorId }), target: group.name })
    return structuredClone(group)
  }

  updateGroup(id: string, patch: Partial<Omit<EnterpriseGroup, "id" | "createdAt">>, actorId?: string): EnterpriseGroup {
    this.assertLicensed()
    const group = this.state.groups.find((entry) => entry.id === id)
    if (group === undefined) throw new EnterpriseStoreError("Unknown group.")
    const updated: EnterpriseGroup = {
      ...group,
      ...(patch.name === undefined ? {} : { name: sanitizeText(patch.name, 120) || group.name }),
      ...(patch.description === undefined ? {} : { description: sanitizeText(patch.description, 400) }),
      ...(patch.role === undefined ? {} : { role: patch.role }),
      ...(patch.modelAllowlist === undefined ? {} : { modelAllowlist: patch.modelAllowlist.filter(Boolean) }),
      ...(patch.monthlyTokenLimit === undefined ? {} : { monthlyTokenLimit: Math.max(0, Math.floor(patch.monthlyTokenLimit)) }),
      ...(patch.monthlySpendLimitUsd === undefined ? {} : { monthlySpendLimitUsd: Math.max(0, patch.monthlySpendLimitUsd) }),
      ...(patch.maxComputers === undefined ? {} : { maxComputers: Math.max(1, Math.floor(patch.maxComputers)) }),
      updatedAt: this.now(),
    }
    this.state.groups = this.state.groups.map((entry) => (entry.id === id ? updated : entry))
    this.save()
    this.appendAudit({ action: "group.updated", ...(actorId === undefined ? {} : { actorId }), target: group.name })
    return structuredClone(updated)
  }

  deleteGroup(id: string, actorId?: string): void {
    this.assertLicensed()
    const group = this.state.groups.find((entry) => entry.id === id)
    if (group === undefined) throw new EnterpriseStoreError("Unknown group.")
    this.state.groups = this.state.groups.filter((entry) => entry.id !== id)
    this.state.users = this.state.users.map((user) => ({
      ...user,
      groupIds: user.groupIds.filter((groupId) => groupId !== id),
    }))
    this.save()
    this.appendAudit({ action: "group.deleted", ...(actorId === undefined ? {} : { actorId }), target: group.name })
  }

  /**
   * Replace a group's membership in one write. Directories deliver membership
   * as a set, so applying it user-by-user would audit a dozen changes and leave
   * a half-synced team behind any failure.
   */
  setGroupMembers(id: string, userIds: readonly string[], actorId?: string): EnterpriseGroup {
    this.assertLicensed()
    const group = this.state.groups.find((entry) => entry.id === id)
    if (group === undefined) throw new EnterpriseStoreError("Unknown group.")
    const members = new Set(userIds.filter((userId) => this.state.users.some((user) => user.id === userId)))
    this.state.users = this.state.users.map((user) => {
      const inGroup = user.groupIds.includes(id)
      const wanted = members.has(user.id)
      if (inGroup === wanted) return user
      return {
        ...user,
        groupIds: wanted ? [...user.groupIds, id] : user.groupIds.filter((groupId) => groupId !== id),
        updatedAt: this.now(),
      }
    })
    const updated: EnterpriseGroup = { ...group, updatedAt: this.now() }
    this.state.groups = this.state.groups.map((entry) => (entry.id === id ? updated : entry))
    this.save()
    this.appendAudit({
      action: "group.updated",
      ...(actorId === undefined ? {} : { actorId }),
      target: group.name,
      metadata: { members: members.size, scim: true },
    })
    return structuredClone(updated)
  }

  // ── Distributions ────────────────────────────────────────────────────────

  createDistribution(input: { name: string; slug?: string; description?: string; actorId?: string }): ClientDistribution {
    this.assertLicensed()
    if (this.state.distributions.length >= MAX_DISTRIBUTIONS) throw new EnterpriseStoreError("Too many distributions.")
    const slug = slugify(input.slug ?? input.name)
    if (slug.length === 0) throw new EnterpriseStoreError("A distribution needs a name.")
    if (this.state.distributions.some((entry) => entry.slug === slug)) throw new EnterpriseStoreError("That distribution URL is already in use.")
    const distribution = defaultDistribution(slug, sanitizeText(input.name, 120) || slug, this.now())
    distribution.description = sanitizeText(input.description ?? "", 400)
    this.state.distributions.push(distribution)
    this.save()
    this.appendAudit({ action: "distribution.created", ...(input.actorId === undefined ? {} : { actorId: input.actorId }), target: distribution.name })
    return structuredClone(distribution)
  }

  updateDistribution(id: string, patch: Partial<ClientDistribution>, actorId?: string): ClientDistribution {
    this.assertLicensed()
    const distribution = this.state.distributions.find((entry) => entry.id === id)
    if (distribution === undefined) throw new EnterpriseStoreError("Unknown distribution.")
    // A published client must not be able to regain social login, and its auth
    // mode is always sso. Only local work-account credentials are implemented
    // today, so normalize here: a crafted payload cannot ship a manifest that
    // advertises an identity flow this server does not serve.
    const requestedExperience = { ...defaultExperience(), ...distribution.experience, ...patch.experience }
    const experience = {
      ...requestedExperience,
      instructions: sanitizeText(requestedExperience.instructions, 4_000),
    }
    const requested = patch.auth ?? distribution.auth
    const auth: ClientAuth = {
      mode: "sso",
      methods: ["password"],
      sessionHours: Math.max(1, Math.min(720, requested.sessionHours)),
      requireMfa: requested.requireMfa === true,
      allowedEmailDomains: requested.allowedEmailDomains
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0)
        .slice(0, 200),
    }
    const features = patch.features === undefined ? distribution.features : { ...distribution.features, ...patch.features }
    const updated: ClientDistribution = {
      ...distribution,
      ...patch,
      id: distribution.id,
      slug: patch.slug === undefined ? distribution.slug : requireSlug(patch.slug),
      name: patch.name === undefined ? distribution.name : sanitizeText(patch.name, 120) || distribution.name,
      description: patch.description === undefined ? distribution.description : sanitizeText(patch.description, 400),
      auth,
      features,
      permissions: normalizePermissions(patch.permissions ?? distribution.permissions, features),
      experience,
      deployment: normalizeDeployment(patch.deployment ?? distribution.deployment),
      updatedAt: this.now(),
    }
    if (this.state.distributions.some((entry) => entry.id !== id && entry.slug === updated.slug)) {
      throw new EnterpriseStoreError("That distribution URL is already in use.")
    }
    this.state.distributions = this.state.distributions.map((entry) => (entry.id === id ? updated : entry))
    this.save()
    this.appendAudit({ action: "distribution.updated", ...(actorId === undefined ? {} : { actorId }), target: updated.name })
    return structuredClone(updated)
  }

  publishDistribution(id: string, version: string, releaseNotes: string, actorId?: string): ClientDistribution {
    this.assertLicensed()
    const distribution = this.state.distributions.find((entry) => entry.id === id)
    if (distribution === undefined) throw new EnterpriseStoreError("Unknown distribution.")
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
      throw new EnterpriseStoreError("The version must look like 1.4.0 or 1.4.0-beta.1.")
    }
    // A build published for use anywhere leaves the private network, so usage
    // has to stay traceable back to this deployment. LAN-only builds may keep
    // telemetry off because the server already sees every client on its wire.
    if (distribution.deployment.mode === "public" && !distribution.telemetry.enabled) {
      throw new EnterpriseStoreError("Turn on client telemetry before publishing a build that works outside the LAN.")
    }
    const updated: ClientDistribution = {
      ...distribution,
      status: "published",
      version,
      releaseNotes: sanitizeText(releaseNotes, 4_000),
      publishedAt: this.now(),
      updatedAt: this.now(),
    }
    this.state.distributions = this.state.distributions.map((entry) => (entry.id === id ? updated : entry))
    this.save()
    this.appendAudit({
      action: "distribution.published",
      ...(actorId === undefined ? {} : { actorId }),
      target: distribution.name,
      metadata: { version },
    })
    return structuredClone(updated)
  }

  duplicateDistribution(id: string, actorId?: string): ClientDistribution {
    const source = this.state.distributions.find((entry) => entry.id === id)
    if (source === undefined) throw new EnterpriseStoreError("Unknown distribution.")
    return this.createDistribution({
      name: `${source.name} copy`,
      slug: `${source.slug}-copy`,
      description: source.description,
      ...(actorId === undefined ? {} : { actorId }),
    })
  }

  deleteDistribution(id: string, actorId?: string): void {
    this.assertLicensed()
    const distribution = this.state.distributions.find((entry) => entry.id === id)
    if (distribution === undefined) throw new EnterpriseStoreError("Unknown distribution.")
    this.state.distributions = this.state.distributions.filter((entry) => entry.id !== id)
    this.state.releases = this.state.releases.filter((release) => release.distributionId !== id)
    this.save()
    this.appendAudit({ action: "distribution.deleted", ...(actorId === undefined ? {} : { actorId }), target: distribution.name })
  }

  /** Begin a platform build. The farm fills in the artifact when it finishes. */
  startRelease(input: {
    readonly distributionId: string
    readonly platform: Platform
    readonly version: string
    readonly actorId?: string
  }): ClientRelease {
    this.assertLicensed()
    const distribution = this.state.distributions.find((entry) => entry.id === input.distributionId)
    if (distribution === undefined) throw new EnterpriseStoreError("Unknown distribution.")
    const release: ClientRelease = {
      id: `rel_${randomBytes(8).toString("hex")}`,
      distributionId: distribution.id,
      distributionSlug: distribution.slug,
      version: input.version,
      platform: input.platform,
      status: "queued",
      startedAt: this.now(),
      log: [],
    }
    this.state.releases = [...this.state.releases, release].slice(-MAX_RELEASES)
    this.save()
    this.appendAudit({
      action: "distribution.build_started",
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      target: distribution.name,
      metadata: { platform: input.platform, version: input.version },
    })
    return structuredClone(release)
  }

  setReleaseStatus(id: string, status: ReleaseStatus): void {
    this.updateRelease(id, (release) => ({ ...release, status }))
  }

  appendReleaseLog(id: string, line: string): void {
    const clean = line.replace(/\u001b\[[0-9;]*m/g, "").slice(0, 500)
    if (clean.trim().length === 0) return
    this.updateRelease(id, (release) => ({ ...release, log: [...release.log, clean].slice(-MAX_RELEASE_LOG) }), false)
  }

  completeRelease(id: string, artifact: { filename: string; bytes: number; sha256: string }): void {
    this.updateRelease(id, (release) => ({
      ...release,
      status: "ready",
      filename: artifact.filename,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      finishedAt: this.now(),
      error: undefined,
    }))
    const release = this.state.releases.find((entry) => entry.id === id)
    this.appendAudit({
      action: "distribution.built",
      target: release?.distributionSlug ?? id,
      metadata: { platform: release?.platform ?? "unknown", version: release?.version ?? "unknown", bytes: artifact.bytes },
    })
  }

  failRelease(id: string, error: string): void {
    this.updateRelease(id, (release) => ({
      ...release,
      status: "failed",
      error: sanitizeText(error, 1_000),
      finishedAt: this.now(),
    }))
    const release = this.state.releases.find((entry) => entry.id === id)
    this.appendAudit({
      action: "distribution.build_failed",
      target: release?.distributionSlug ?? id,
      metadata: { platform: release?.platform ?? "unknown", version: release?.version ?? "unknown" },
    })
  }

  manifest(distribution: ClientDistribution, publicUrl: string): ClientManifest {
    const installers: InstallerLink[] = distribution.deployment.platforms.map((platform) => {
      const release = this.releaseFor(distribution, platform)
      const external = (distribution.deployment.installerBaseUrl ?? "").trim().replace(/\/$/, "")
      const url =
        external.length > 0
          ? `${external}/${platform}/${distribution.slug}-${distribution.version}.zip`
          : `${publicUrl}/v1/enterprise/public/client/${encodeURIComponent(distribution.slug)}/download/${platform}`
      return {
        platform,
        url,
        available: distribution.status === "published",
        kind: external.length > 0 || release !== undefined ? "installer" : "enrollment",
        ...(release?.bytes === undefined ? {} : { bytes: release.bytes }),
        ...(release?.sha256 === undefined ? {} : { sha256: release.sha256 }),
      }
    })
    const { oidc: _oidc, saml: _saml, ...auth } = distribution.auth
    const { customCaCertificate: _ca, ...deployment } = distribution.deployment
    return {
      schema: 1,
      distribution: distribution.slug,
      name: distribution.name,
      version: distribution.version,
      ...(distribution.publishedAt === undefined ? {} : { publishedAt: distribution.publishedAt }),
      org: { name: this.state.organization.name, slug: this.state.organization.slug },
      branding: absoluteBranding(publicUrl, distribution.branding),
      auth: { ...structuredClone(auth), mode: "sso", allowSocialLogin: false },
      features: structuredClone(distribution.features),
      permissions: normalizePermissions(distribution.permissions, distribution.features),
      experience: structuredClone(distribution.experience),
      limits: structuredClone(distribution.limits),
      models: structuredClone(distribution.models),
      telemetry: structuredClone(distribution.telemetry),
      update: structuredClone(distribution.update),
      deployment: { ...structuredClone(deployment), installers },
    }
  }

  private updateRelease(
    id: string,
    mutate: (release: ClientRelease) => ClientRelease,
    persist = true,
  ): void {
    const release = this.state.releases.find((entry) => entry.id === id)
    if (release === undefined) throw new EnterpriseStoreError("Unknown release.")
    Object.assign(release, mutate(structuredClone(release)))
    if (persist) this.save()
  }

  // ── Organization, policies, license ──────────────────────────────────────

  updateOrganization(
    patch: Partial<Omit<OrganizationSettings, "branding" | "integrations">> & {
      branding?: Partial<import("./types").Branding>
      integrations?: Partial<import("./types").Integrations>
    },
    actorId?: string,
  ): OrganizationSettings {
    const org = this.state.organization
    const next: OrganizationSettings = {
      ...org,
      ...(patch.name === undefined ? {} : { name: sanitizeText(patch.name, 120) || org.name }),
      ...(patch.supportEmail === undefined ? {} : { supportEmail: sanitizeEmail(patch.supportEmail) }),
      ...(patch.website === undefined ? {} : { website: sanitizeUrl(patch.website) }),
      ...(patch.logoUrl === undefined ? {} : { logoUrl: sanitizeUrl(patch.logoUrl) }),
      ...(patch.region === undefined ? {} : { region: sanitizeText(patch.region, 64) || org.region }),
      ...(patch.branding === undefined ? {} : { branding: mergeBranding(org.branding, patch.branding) }),
      ...(patch.smtp === undefined ? {} : { smtp: patch.smtp }),
      ...(patch.integrations === undefined ? {} : { integrations: { ...org.integrations, ...patch.integrations } }),
      updatedAt: this.now(),
    }
    this.state.organization = next
    this.save()
    this.appendAudit({ action: "org.updated", ...(actorId === undefined ? {} : { actorId }) })
    return structuredClone(next)
  }

  updatePolicies(patch: Partial<Policies>, actorId?: string): Policies {
    this.assertLicensed()
    const current = this.state.organization.policies
    const next: Policies = {
      ...current,
      ...patch,
      model: { ...current.model, ...(patch.model ?? {}) },
      tools: { ...current.tools, ...(patch.tools ?? {}) },
      data: { ...current.data, ...(patch.data ?? {}) },
      audit: { ...current.audit, ...(patch.audit ?? {}) },
      network: { ...current.network, ...(patch.network ?? {}) },
      ipAllowlist: (patch.ipAllowlist ?? current.ipAllowlist).map((entry) => entry.trim()).filter(Boolean).slice(0, 200),
      sessionHours: Math.max(1, Math.min(720, patch.sessionHours ?? current.sessionHours)),
      idleTimeoutMinutes: Math.max(5, Math.min(1_440, patch.idleTimeoutMinutes ?? current.idleTimeoutMinutes)),
    }
    this.state.organization = { ...this.state.organization, policies: next, updatedAt: this.now() }
    this.save()
    this.appendAudit({ action: "policy.updated", ...(actorId === undefined ? {} : { actorId }) })
    return structuredClone(next)
  }

  setLicense(token: string, claims: import("./types").LicenseClaims | undefined, error: string | undefined, actorId?: string): OrganizationSettings {
    this.state.organization = {
      ...this.state.organization,
      license: { token, ...(claims === undefined ? {} : { claims }), verifiedAt: this.now(), ...(error === undefined ? {} : { error }) },
      updatedAt: this.now(),
    }
    this.save()
    this.appendAudit({
      action: error === undefined ? "license.activated" : "license.rejected",
      ...(actorId === undefined ? {} : { actorId }),
      ...(claims === undefined ? {} : { metadata: { plan: claims.plan, seats: claims.seats, expiresAt: claims.expiresAt } }),
    })
    return structuredClone(this.state.organization)
  }

  rotateScimToken(actorId?: string): string {
    this.assertLicensed()
    const token = `oms_scim_${randomBytes(24).toString("base64url")}`
    this.state.organization = {
      ...this.state.organization,
      scimTokenHash: hashToken(token),
      scimEnabled: true,
      integrations: { ...this.state.organization.integrations, scimEnabled: true },
      updatedAt: this.now(),
    }
    this.save()
    this.appendAudit({ action: "scim.token_rotated", ...(actorId === undefined ? {} : { actorId }) })
    return token
  }

  verifyScimToken(token: string | undefined): boolean {
    if (token === undefined || this.state.organization.scimTokenHash === undefined) return false
    return hashToken(token) === this.state.organization.scimTokenHash
  }

  // ── Events ───────────────────────────────────────────────────────────────

  // ── Legal bans ───────────────────────────────────────────────────────

  /**
   * Picks up ban changes written by another process, such as the operator CLI
   * running `ban`/`unban` against a live server.
   *
   * Only the ban collection is reloaded: the rest of the state belongs to this
   * process, and replacing it wholesale would drop writes made since the read.
   * The file is written with an atomic rename, so this read is consistent.
   */
  private syncLegalBans(): void {
    const mtime = mtimeOf(this.file)
    if (mtime === 0 || mtime === this.legalBansAt) return
    try {
      const next = readState(this.file)
      this.state.legalBans = (next.legalBans ?? []).filter(
        (ban) => ban.kind === "account" || ban.kind === "installation",
      )
      this.legalBansAt = mtime
    } catch {
      // An unreadable file keeps the loaded bans in force: the safe failure for
      // enforcement is to keep blocking, not to let a broken file lift a ban.
    }
  }

  /** Every ban, lifted ones included; the console lists them for appeals. */
  legalBans(): readonly LegalBan[] {
    this.syncLegalBans()
    return structuredClone(this.state.legalBans ?? [])
  }

  /**
   * The answer the ban endpoint publishes for one caller.
   *
   * An account ban and an installation ban are independent: either one blocks
   * the caller, and a lifted record blocks nobody. An email that fails
   * validation or a fingerprint that is not hex matches nothing, so junk input
   * can never accidentally hit a stored ban.
   */
  legalDecision(input: { readonly email?: string; readonly fingerprint?: string }): LegalDecision {
    this.syncLegalBans()
    const email = sanitizeEmail(input.email)
    const fingerprint = normalizeFingerprint(input.fingerprint)
    const match = (this.state.legalBans ?? []).find(
      (ban) =>
        ban.liftedAt === undefined &&
        ((ban.kind === "account" && email !== undefined && ban.value === email) ||
          (ban.kind === "installation" && fingerprint !== undefined && ban.value === fingerprint)),
    )
    if (match === undefined) return { banned: false }
    return { banned: true, reason: match.reason, bannedAt: match.bannedAt }
  }

  /** Applies a ban, or refreshes the reason of one that is already active. */
  banLegalSubject(input: {
    kind: LegalBanKind
    value: string
    reason: string
    createdBy: string
    at?: number
  }): LegalBan {
    const value = requireLegalSubject(input.kind, input.value)
    const reason = sanitizeText(input.reason, 300)
    if (reason.length === 0) throw new EnterpriseStoreError("A ban needs a reason the user can read.")
    const existing = (this.state.legalBans ?? []).find(
      (ban) => ban.kind === input.kind && ban.value === value && ban.liftedAt === undefined,
    )
    if (existing !== undefined) {
      const updated: LegalBan = { ...existing, reason }
      this.state.legalBans = (this.state.legalBans ?? []).map((ban) => (ban.id === existing.id ? updated : ban))
      this.save()
      return structuredClone(updated)
    }
    const ban: LegalBan = {
      id: `ban_${randomBytes(8).toString("hex")}`,
      kind: input.kind,
      value,
      reason,
      bannedAt: input.at ?? this.now(),
      createdBy: sanitizeText(input.createdBy, 200) || "operator",
    }
    this.state.legalBans = [...(this.state.legalBans ?? []), ban].slice(-MAX_LEGAL_BANS)
    this.appendAudit({ action: "legal.ban_applied", target: value, metadata: { kind: input.kind, createdBy: ban.createdBy } })
    return structuredClone(ban)
  }

  /**
   * Lifts the active ban for one subject. The record stays in the store with
   * `liftedAt` set, so the same file explains why the account was blocked and
   * who released it. Returns undefined when nothing was active.
   */
  liftLegalBan(input: { kind: LegalBanKind; value: string; liftedBy: string }): LegalBan | undefined {
    const value = requireLegalSubject(input.kind, input.value)
    const active = (this.state.legalBans ?? []).find(
      (ban) => ban.kind === input.kind && ban.value === value && ban.liftedAt === undefined,
    )
    if (active === undefined) return undefined
    const liftedBy = sanitizeText(input.liftedBy, 200) || "operator"
    const lifted: LegalBan = { ...active, liftedAt: this.now(), liftedBy }
    this.state.legalBans = (this.state.legalBans ?? []).map((ban) => (ban.id === active.id ? lifted : ban))
    this.appendAudit({ action: "legal.ban_lifted", target: value, metadata: { kind: input.kind, liftedBy } })
    return structuredClone(lifted)
  }

  appendAudit(input: Omit<AuditEvent, "id" | "at"> & { at?: number }): AuditEvent {
    const at = input.at ?? this.now()
    const event: AuditEvent = {
      id: `aud_${randomBytes(8).toString("hex")}`,
      at,
      action: input.action as AuditAction,
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      ...(input.actorEmail === undefined ? {} : { actorEmail: input.actorEmail }),
      ...(input.target === undefined ? {} : { target: sanitizeText(input.target, 256) }),
      ...(input.ip === undefined ? {} : { ip: sanitizeText(input.ip, 64) }),
      ...(input.userAgent === undefined ? {} : { userAgent: sanitizeText(input.userAgent, 256) }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    }
    this.state.audit.push(event)
    if (this.state.audit.length > MAX_AUDIT) this.state.audit = this.state.audit.slice(-MAX_AUDIT)
    this.save()
    return structuredClone(event)
  }

  appendUsage(input: Omit<UsageEvent, "id" | "at"> & { at?: number }): UsageEvent {
    return this.appendUsageBatch([input])[0]!
  }

  appendUsageBatch(inputs: readonly (Omit<UsageEvent, "id" | "at"> & { at?: number })[]): UsageEvent[] {
    if (inputs.length === 0) return []
    const events = inputs.map((input) => {
      const at = input.at ?? this.now()
      const event: UsageEvent = {
        id: `usev_${randomBytes(8).toString("hex")}`,
        at,
        userId: input.userId,
        model: sanitizeText(input.model, 160) || "unknown",
        ...(input.provider === undefined ? {} : { provider: sanitizeText(input.provider, 64) }),
        inputTokens: clampCount(input.inputTokens),
        outputTokens: clampCount(input.outputTokens),
        costUsd: clampCost(input.costUsd),
        ...(input.tool === undefined ? {} : { tool: sanitizeText(input.tool, 64) }),
        ...(input.computerId === undefined ? {} : { computerId: sanitizeText(input.computerId, 128) }),
        ...(input.sessionId === undefined ? {} : { sessionId: sanitizeText(input.sessionId, 128) }),
        ...(input.durationMs === undefined ? {} : { durationMs: clampCount(input.durationMs) }),
        ...(input.distributionId === undefined ? {} : { distributionId: sanitizeText(input.distributionId, 128) }),
      }
      return event
    })
    const previous = this.state.usage
    this.state.usage = [...previous, ...events].slice(-MAX_USAGE)
    try {
      this.save()
    } catch (error) {
      this.state.usage = previous
      throw error
    }
    return structuredClone(events)
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private pushUser(user: EnterpriseUser): void {
    if (this.state.users.length >= MAX_USERS) throw new EnterpriseStoreError("Too many users.")
    this.state.users.push(user)
  }

  private ownerCount(): number {
    return this.state.users.filter((user) => user.role === "owner" && user.status === "active").length
  }

  private pruneSessions(at: number): void {
    this.state.sessions = this.state.sessions.filter((session) => session.expiresAt > at).slice(-MAX_SESSIONS)
  }

  private save(): void {
    const directory = dirname(this.file)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (existsSync(this.file) && lstatSync(this.file).isSymbolicLink()) {
      throw new EnterpriseStoreError(`Refusing to write ${this.file} through a symlink.`)
    }
    const temporary = join(directory, `.${process.pid}-${randomBytes(4).toString("hex")}.tmp`)
    try {
      const handle = openSync(temporary, "wx", 0o600)
      try {
        writeFileSync(handle, JSON.stringify(this.state, null, 2))
        fsyncSync(handle)
      } finally {
        closeSync(handle)
      }
      chmodSync(temporary, 0o600)
      renameSync(temporary, this.file)
      chmodSync(this.file, 0o600)
      this.lastWriteAt = this.now()
      this.legalBansAt = mtimeOf(this.file)
      this.writable = true
    } catch (error) {
      rmSync(temporary, { force: true })
      this.writable = false
      throw error
    }
  }
}

// ── Parsing and validation ─────────────────────────────────────────────────

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

function readState(file: string): EnterpriseState {
  if (lstatSync(file).isSymbolicLink()) throw new EnterpriseStoreError(`Refusing to read ${file} through a symlink.`)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    preserveCorrupt(file)
    throw new EnterpriseStoreError(`The enterprise store at ${file} is not valid JSON. The original bytes were kept as ${file}.corrupt.`)
  }
  if (typeof parsed !== "object" || parsed === null) {
    preserveCorrupt(file)
    throw new EnterpriseStoreError(`The enterprise store at ${file} has an unexpected shape.`)
  }
  const record = parsed as Record<string, unknown>
  if (record.version !== ENTERPRISE_STATE_VERSION) {
    throw new EnterpriseStoreError(`Enterprise store version ${String(record.version)} is not supported (expected ${ENTERPRISE_STATE_VERSION}).`)
  }
  if (!Array.isArray(record.users) || !Array.isArray(record.sessions) || !Array.isArray(record.groups)) {
    preserveCorrupt(file)
    throw new EnterpriseStoreError(`The enterprise store at ${file} is missing required collections.`)
  }
  return parsed as EnterpriseState
}

function preserveCorrupt(file: string) {
  try {
    renameSync(file, `${file}.corrupt`)
  } catch {
    // Nothing to preserve, or the directory is not writable.
  }
  try {
    unlinkSync(`${file}.tmp`)
  } catch {
    // Already gone.
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

export function sanitizeText(value: unknown, max = MAX_STRING): string {
  if (typeof value !== "string") return ""
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max)
}

function normalizeFingerprint(value: unknown): string | undefined {
  const text = sanitizeText(value, 64).toLowerCase()
  return /^[0-9a-f]{8,64}$/.test(text) ? text : undefined
}

function requireLegalSubject(kind: LegalBanKind, value: unknown): string {
  const subject = kind === "account" ? sanitizeEmail(value) : normalizeFingerprint(value)
  if (subject !== undefined) return subject
  throw new EnterpriseStoreError(
    kind === "account" ? "A valid email address is required." : "A valid installation fingerprint is required.",
  )
}

export function sanitizeEmail(value: unknown): string | undefined {
  const text = sanitizeText(value, 254).toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text)) return undefined
  return text
}

function requireEmail(value: unknown): string {
  const email = sanitizeEmail(value)
  if (email === undefined) throw new EnterpriseStoreError("A valid email address is required.")
  return email
}

function sanitizeUrl(value: unknown): string | undefined {
  const text = sanitizeText(value, 512)
  if (text.length === 0) return undefined
  try {
    const url = new URL(text)
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

function normalizeDeployment(value: ClientDeployment): ClientDeployment {
  return {
    platforms: [...new Set(value.platforms.filter((platform): platform is Platform => PLATFORMS.includes(platform)))],
    mode: isNetworkMode(value.mode) ? value.mode : "lan",
    ...(value.installerBaseUrl === undefined || value.installerBaseUrl.trim().length === 0
      ? {}
      : { installerBaseUrl: value.installerBaseUrl.trim().slice(0, MAX_STRING) }),
    offlineBundle: value.offlineBundle === true,
    ...(value.proxyUrl === undefined || value.proxyUrl.trim().length === 0
      ? {}
      : { proxyUrl: value.proxyUrl.trim().slice(0, MAX_STRING) }),
    ...(value.customCaCertificate === undefined || value.customCaCertificate.trim().length === 0
      ? {}
      : { customCaCertificate: value.customCaCertificate.slice(0, 32_000) }),
  }
}

function requireSlug(value: unknown): string {
  const slug = slugify(typeof value === "string" ? value : "")
  if (slug.length === 0) throw new EnterpriseStoreError("A distribution URL is required.")
  return slug
}

function mergeBranding(current: import("./types").Branding, patch: Partial<import("./types").Branding>) {
  return {
    productName: sanitizeText(patch.productName ?? current.productName, 80) || current.productName,
    shortName: sanitizeText(patch.shortName ?? current.shortName, 40) || current.shortName,
    tagline: sanitizeText(patch.tagline ?? current.tagline, 160),
    primaryColor: color(patch.primaryColor ?? current.primaryColor, current.primaryColor),
    accentColor: color(patch.accentColor ?? current.accentColor, current.accentColor),
    logoUrl: patch.logoUrl === undefined ? current.logoUrl : sanitizeUrl(patch.logoUrl),
    iconUrl: patch.iconUrl === undefined ? current.iconUrl : sanitizeUrl(patch.iconUrl),
    signInHeadline: sanitizeText(patch.signInHeadline ?? current.signInHeadline, 160) || current.signInHeadline,
    signInSubheadline: sanitizeText(patch.signInSubheadline ?? current.signInSubheadline, 240),
    supportUrl: patch.supportUrl === undefined ? current.supportUrl : sanitizeUrl(patch.supportUrl),
    docsUrl: patch.docsUrl === undefined ? current.docsUrl : sanitizeUrl(patch.docsUrl),
    footerText: patch.footerText === undefined ? current.footerText : sanitizeText(patch.footerText, 160),
    showOmniaBranding: patch.showOmniaBranding ?? current.showOmniaBranding,
  }
}

function color(value: string, fallback: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback
}

function clampCount(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.min(Math.floor(value), 10_000_000_000)
}

function clampCost(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.round(Math.min(value, 1_000_000) * 1_000_000) / 1_000_000
}

export function defaultStorePath(directory: string): string {
  return join(directory, "enterprise.json")
}
