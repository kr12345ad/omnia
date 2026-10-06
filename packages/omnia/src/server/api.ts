import type { IncomingMessage, ServerResponse } from "node:http"
import { createHmac, timingSafeEqual } from "node:crypto"
import { handleBillingRoute } from "./billing-api"
import { failsClosed, isPlanId, type Capability, type PlanId } from "../billing/plans"
import type { EventBus, ServerEvent } from "./events"
import type { ComputerManager, DragEndpoint, ServerActionRequest, ServerBatchStep } from "./computers"
import { OMNIA_ACTION_CATALOG } from "./catalog"
import { parseActionScript, renderAnthropicTools, renderCatalogText, renderOpenAiTools } from "./text-protocol"
import { summarizeSuperskill } from "../superskills/registry"
import type { Superskill, SuperskillSummary } from "../superskills/types"
import type { MemoryQuery, MemoryRecord, MemoryStats, MemoryWriteInput } from "../memory/types"
import { isMemoryScope } from "../memory/store"
import { cuaDriverFor, type ComputerUseService } from "../computer-use/service"
import type { CalibrationManager, CalibrationMeasurement, CalibrationProfile } from "../computer-use/calibration"
import type { CuaAction, CuaFindQuery, CuaWaitCondition } from "../cua/types"
import { renderGitHubCallbackPage, type GitHubAuth } from "../auth/github"
import type {
  ComputerUseContext,
  ComputerUseOperation,
  ComputerUsePrivacy,
  ImageReference,
  SemanticElement,
  SemanticEnvironment,
} from "../computer-use/types"
import {
  describePermissions,
  isOmniaScope,
  PERMISSION_STATES,
  requiredScopesForAction,
  type ApprovalInput,
  type OmniaScope,
  type PermissionManager,
  type PermissionState,
} from "./permissions"
import { isCredentialKind, isCredentialRuleKind, summarizeCredential, type CredentialStore } from "../credentials"
import type { PairingManager } from "../pairing"
import { formatPairingCode } from "../pairing"
import { parseRemotePublicKey, type RemoteRegistry } from "./remote"
import { REMOTE_KEY_ID_HEADER, REMOTE_SIGNATURE_HEADER, REMOTE_TIMESTAMP_HEADER } from "../remote/signing"
import {
  isCapabilitySupport,
  isComputerInfo,
  type Bounds,
  type CapabilitySupport,
  type ComputerInfo,
  type ElementReference,
} from "../protocol"
import { operationFingerprint, type ApprovalRegistry } from "../security/approval"
import type { OperationInput } from "../security/types"

export const OMNIA_PROTOCOL_VERSION = 1
export const OMNIA_API_VERSION = "v1"
export const OMNIA_API_PREFIX = "/v1"
export const OMNIA_BODY_LIMIT_BYTES = 16 * 1024 * 1024
export const OMNIA_SSE_HEARTBEAT_MS = 15000
export const OMNIA_SESSION_ID_MAX_LENGTH = 128

export type ServerHealthState = "starting" | "ready" | "degraded" | "stopping" | "stopped" | "failed"

export interface SubsystemHealth {
  readonly name: string
  readonly status: "ready" | "degraded" | "unavailable" | "failed"
  readonly reason?: string
}

export interface ServerHealth {
  readonly status: ServerHealthState
  readonly version: string
  readonly protocol: number
  readonly api: string
  readonly serverId: string
  readonly uptimeMs: number
  readonly activeSessions: number
  readonly connectedComputers: number
  readonly subsystems: readonly SubsystemHealth[]
  readonly startedAt: number
}

export interface ServerCatalogEntry {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly provider?: string
  readonly capabilities?: Readonly<Record<string, boolean | number>>
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface ServerCatalog {
  readonly agents: readonly ServerCatalogEntry[]
  readonly skills: readonly ServerCatalogEntry[]
  readonly models: readonly ServerCatalogEntry[]
}

export interface ServerDescriptor {
  readonly serverId: string
  readonly version: string
  readonly startedAt: number
  readonly platform: string
}

export interface ServerSession {
  readonly id: string
  readonly computerId?: string
  readonly actions: number
  readonly lastActionAt: number
}

export interface ApiContext {
  readonly descriptor: ServerDescriptor
  // The server bearer token. It keys the session proof that binds a caller
  // supplied session id to this server instance.
  readonly token: string
  readonly events: EventBus
  readonly computers: ComputerManager
  readonly permissions: PermissionManager
  readonly credentials: CredentialStore
  readonly pairings: PairingManager
  readonly remote: RemoteRegistry
  readonly pairingUrl: () => string
  readonly catalog: () => ServerCatalog
  readonly registerModels: (models: readonly ServerCatalogEntry[]) => void
  readonly superskills: () => readonly SuperskillSummary[]
  readonly superskill: (id: string) => Superskill | undefined
  readonly saveSuperskill: (input: unknown) => Superskill
  readonly removeSuperskill: (id: string) => boolean
  readonly callSuperskill: (id: string, method: string, params: unknown) => Promise<unknown>
  readonly memories: (query: MemoryQuery) => readonly MemoryRecord[]
  readonly memoryStats: () => MemoryStats
  readonly writeMemory: (input: MemoryWriteInput) => MemoryRecord
  readonly removeMemory: (id: string) => boolean
  readonly forgetMemories: (query: MemoryQuery) => number
  readonly sessions: () => readonly ServerSession[]
  readonly computerUse: ComputerUseService
  readonly calibration: CalibrationManager
  readonly approvals: ApprovalRegistry
  readonly auth: GitHubAuth
  readonly health: () => ServerHealth
  readonly subscribe: (response: ServerResponse) => () => void
  readonly now: () => number
}

export interface ParsedRequest {
  readonly method: string
  readonly pathname: string
  readonly segments: readonly string[]
  readonly url: URL
}

export function parseRequest(request: IncomingMessage): ParsedRequest {
  const url = new URL(request.url ?? "/", "http://127.0.0.1")
  const pathname = url.pathname.replace(/\/+$/, "") || "/"
  return {
    method: request.method ?? "GET",
    pathname,
    segments: pathname.split("/").filter((segment) => segment.length > 0),
    url,
  }
}

export function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization ?? ""
  if (!header.startsWith("Bearer ")) return undefined
  const presented = header.slice("Bearer ".length)
  return presented.length === 0 ? undefined : presented
}

export function isAuthorized(
  request: IncomingMessage,
  token: string,
  timingSafeEqual: (a: Buffer, b: Buffer) => boolean,
  clientTokens?: { isClientToken: (token: string) => boolean },
): boolean {
  const presented = bearerToken(request)
  if (presented === undefined) return false
  if (clientTokens?.isClientToken(presented) === true) return true
  if (token.length === 0) return false
  const expected = Buffer.from(token)
  const actual = Buffer.from(presented)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/**
 * Routes that must be reachable WITHOUT a bearer token, and what authenticates
 * them instead.
 *
 * This list exists as one named function because getting it wrong is silent and
 * expensive in both directions: leave a public route out and a legitimate client
 * gets a 401 it can never fix (the desktop app could not sign in; Stripe could
 * not deliver a subscription), and put a privileged route in and you have
 * handed out access for free. Anything added here needs a comment saying what
 * stands in for the token.
 */
export function isPublicApiRoute(method: string, pathname: string): boolean {
  if (!pathname.startsWith(`${OMNIA_API_PREFIX}/`)) return false
  const route = pathname.slice(OMNIA_API_PREFIX.length)
  // The GitHub OAuth handshake, which by definition runs before anyone holds a
  // credential. Authorization is the signed state parameter.
  if (method === "POST" && route === "/auth/github/start") return true
  if (method === "GET" && route === "/auth/github/callback") return true
  if (method === "GET" && route === "/auth/github/status") return true
  if (method === "POST" && route === "/auth/github/poll") return true
  // Stripe cannot present an Omnia bearer. It authenticates with a signature
  // over the raw body, verified before anything is parsed or written. Matched on
  // path rather than method so a misconfigured Stripe dashboard gets an honest
  // "POST only" instead of a 401 that looks like a credential problem.
  if (route === "/billing/stripe/webhook") return true
  return false
}

// The server token is the root credential the desktop UI holds, and comparing
// it against the presented bearer in constant time is the only way to recognize
// the operator. Client tokens and remote computer tokens are authorized by
// isAuthorized but are never operator, so every operator-only route keys off
// this rather than off anything the caller puts in a header or a body.
export function presentsServerToken(context: Pick<ApiContext, "token">, request: IncomingMessage): boolean {
  const presented = bearerToken(request)
  if (presented === undefined || context.token.length === 0) return false
  if (presented.length !== context.token.length) return false
  return timingSafeEqual(Buffer.from(presented), Buffer.from(context.token))
}

export class RequestBodyTooLargeError extends Error {
  readonly code = "request_body_too_large"
  readonly status = 413

  constructor() {
    super("Request body too large.")
    this.name = "RequestBodyTooLargeError"
  }
}

export class InvalidJsonBodyError extends Error {
  readonly code = "invalid_json_body"
  readonly status = 400

  constructor() {
    super("Request body is not valid JSON.")
    this.name = "InvalidJsonBodyError"
  }
}

export class SessionUnboundError extends Error {
  readonly code = "session_unbound"
  readonly status = 401

  constructor(sessionId: string) {
    super(`Session ${sessionId} is not bound to this client.`)
    this.name = "SessionUnboundError"
  }
}

export class SessionMismatchError extends Error {
  readonly code: string = "session_mismatch"
  readonly status = 400

  constructor(message = "The x-omnia-session header and body sessionId must match.") {
    super(message)
    this.name = "SessionMismatchError"
  }
}

// An over-long session id is a malformed session, which server.ts answers with
// the same 400 branch as a mismatch, so it extends SessionMismatchError rather
// than falling through to an opaque 500.
export class SessionIdTooLongError extends SessionMismatchError {
  override readonly code: string = "session_id_too_long"

  constructor() {
    super(`The session id must be at most ${OMNIA_SESSION_ID_MAX_LENGTH} characters.`)
    this.name = "SessionIdTooLongError"
  }
}

export function readBodyBytes(request: IncomingMessage, limit = OMNIA_BODY_LIMIT_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0
    let settled = false
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        // Do not destroy the request here: the caller still has to write the
        // 413 response, and destroying the socket first would turn it into a
        // connection reset. The remaining body is drained by the caller.
        settled = true
        reject(new RequestBodyTooLargeError())
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    request.on("error", (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

export function parseBodyBytes(bytes: Buffer): unknown {
  if (bytes.length === 0) return undefined
  try {
    return JSON.parse(bytes.toString("utf8"))
  } catch {
    throw new InvalidJsonBodyError()
  }
}

export function readBody(request: IncomingMessage, limit = OMNIA_BODY_LIMIT_BYTES): Promise<unknown> {
  return readBodyBytes(request, limit).then(parseBodyBytes)
}

export function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) {
    // An SSE stream or another handler already wrote the head; appending a
    // JSON body would throw ERR_HTTP_HEADERS_SENT.
    if (!response.writableEnded) response.end()
    return
  }
  const body = JSON.stringify(value)
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "access-control-allow-origin": "*",
    "access-control-allow-headers":
      "authorization, content-type, x-omnia-origin, x-omnia-session, x-omnia-session-proof, x-omnia-key-id, x-omnia-timestamp, x-omnia-signature",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "cache-control": "no-store",
  })
  response.end(body)
}

function html(response: ServerResponse, status: number, body: string): void {
  if (response.headersSent) {
    if (!response.writableEnded) response.end()
    return
  }
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  })
  response.end(body)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === "string")
}

// The desktop UI and the agent runtime share one bearer token, so origin is
// carried explicitly. The header can only ever say "agent"; it never promotes a
// request to desktop, because the caller controls it.
export function requestOrigin(request: IncomingMessage): "desktop" | "agent" {
  const header = request.headers["x-omnia-origin"]
  if (typeof header === "string" && header.trim().toLowerCase() === "agent") return "agent"
  return "desktop"
}

export function requestSessionId(request: IncomingMessage, body?: Record<string, unknown>): string | undefined {
  const header = request.headers["x-omnia-session"]
  const candidate =
    typeof body?.sessionId === "string" && body.sessionId.length > 0
      ? body.sessionId
      : typeof header === "string" && header.length > 0
        ? header
        : undefined
  // An over-long id is rejected with a 400 by checkSessionBinding before any
  // route reads it, so it can never be silently dropped and mistaken for "no
  // session", which would classify the caller as desktop.
  if (candidate === undefined || candidate.length > OMNIA_SESSION_ID_MAX_LENGTH) return undefined
  return candidate
}

// A session claim of any length disqualifies the operator. requestSessionId
// drops an over-long id, so asking it here would quietly promote a caller that
// sent one and let it read as "no session"; checkSessionBinding rejects those
// requests with a 400 before any route reaches this point.
function claimsSession(request: IncomingMessage, body?: Record<string, unknown>): boolean {
  const header = request.headers["x-omnia-session"]
  if (typeof header === "string" && header.length > 0) return true
  return typeof body?.sessionId === "string" && body.sessionId.length > 0
}

// Trust comes from the presented token, never from caller-supplied headers.
// Only the server token is the trusted desktop UI; a client token (a
// provisioned thin client) or a remote computer token is at best an agent, so a
// caller cannot look like the UI by omitting x-omnia-origin/x-omnia-session.
// A session id or an explicit agent origin can only take privileges away from a
// server-token request, which is how the agent runtime identifies itself.
export function isOperatorRequest(
  context: Pick<ApiContext, "token">,
  request: IncomingMessage,
  body?: Record<string, unknown>,
): boolean {
  if (!presentsServerToken(context, request)) return false
  if (requestOrigin(request) !== "desktop") return false
  return !claimsSession(request, body)
}

// The signed-in person's own desktop, trusted for the APIs its UI drives
// (its credentials, memories, files and its own computers) but never an
// operator. Two credentials qualify:
//
//   - the server token with the desktop origin and no session claim, and
//   - a client token minted by the GitHub sign-in flow ("desktop" kind).
//
// The second case matters because the desktop app authenticates with a client
// token, not the server token: without it every settings call came back as
// "approval required for FILES_READ" / "Denied by policy: SECRETS". Operator
// provisioned client tokens are deliberately NOT here, so automation still
// gets gated.
export function isTrustedDesktopRequest(
  context: Pick<ApiContext, "token" | "auth">,
  request: IncomingMessage,
  body?: Record<string, unknown>,
): boolean {
  if (isOperatorRequest(context, request, body)) return true
  const presented = bearerToken(request)
  if (presented === undefined || presented.length === 0) return false
  return context.auth.clientTokenKind(presented) === "desktop"
}

function isAgentRequest(
  context: Pick<ApiContext, "token" | "auth">,
  request: IncomingMessage,
  body: Record<string, unknown> = {},
): boolean {
  return !isTrustedDesktopRequest(context, request, body)
}

// A session id is only meaningful when the caller can prove it holds the same
// bearer token it authenticated with: HMAC-SHA256(bearerToken, sessionId) in
// lowercase hex. Without that proof any token holder could claim another
// agent's session and inherit its permission grants. Client tokens work too,
// so desktop sidecars bound to a client token can own their sessions.
export function sessionProof(token: string, sessionId: string): string {
  return createHmac("sha256", token).update(sessionId, "utf8").digest("hex")
}

export function checkSessionBinding(
  context: ApiContext,
  request: IncomingMessage,
  body?: Record<string, unknown>,
): void {
  const header = request.headers["x-omnia-session"]
  const headerSession = typeof header === "string" && header.length > 0 ? header : undefined
  const bodySession =
    typeof body?.sessionId === "string" && body.sessionId.length > 0 ? body.sessionId : undefined
  if (headerSession !== undefined && bodySession !== undefined && headerSession !== bodySession) {
    throw new SessionMismatchError()
  }
  const sessionId = bodySession ?? headerSession
  if (sessionId === undefined) return
  // Reject rather than ignore: an over-long id used to skip the proof check and
  // make requestSessionId return undefined, which classified the caller as the
  // desktop operator no matter which token it presented.
  if (sessionId.length > OMNIA_SESSION_ID_MAX_LENGTH) throw new SessionIdTooLongError()
  const proofHeader = request.headers["x-omnia-session-proof"]
  const presented = typeof proofHeader === "string" ? proofHeader.trim().toLowerCase() : ""
  const expected = sessionProof(bearerToken(request) ?? context.token, sessionId)
  if (presented.length !== expected.length || !timingSafeEqual(Buffer.from(presented), Buffer.from(expected))) {
    throw new SessionUnboundError(sessionId)
  }
}

async function readBoundBody(context: ApiContext, request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request)
  checkSessionBinding(context, request, isRecord(body) ? body : undefined)
  return body
}

function finiteNumber(value: unknown, bounds: { min?: number; max?: number } = {}): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  const min = bounds.min ?? Number.NEGATIVE_INFINITY
  const max = bounds.max ?? Number.POSITIVE_INFINITY
  return Math.min(max, Math.max(min, value))
}

// approve/approvedScopes in a request body are the caller's own claim to
// approval, forwarded by the agent runtime when it replays the scopes an
// operator confirmed for its session. Only a caller that authenticated with the
// server token can make that claim count; a client token is a provisioning
// credential and never approves its own request. Even for the operator the claim
// stays weak: permissions.evaluate only lets it lift a scope left at "prompt",
// so a "denied" scope still needs a fingerprint-bound grant from
// /v1/permissions/approve. A fingerprint is proof this server issued, so it is
// forwarded for every caller.
function approvalFromBody(
  context: Pick<ApiContext, "token">,
  request: IncomingMessage,
  body: Record<string, unknown>,
): ApprovalInput {
  const mayApprove = presentsServerToken(context, request)
  const scopes = asStringArray(body.approvedScopes)?.filter(isOmniaScope)
  return {
    ...(mayApprove ? { approved: body.approve === true } : { approved: false }),
    ...(typeof body.approvedBy === "string" ? { approvedBy: body.approvedBy } : {}),
    ...(mayApprove && scopes !== undefined ? { scopes } : {}),
    ...(typeof body.approvalFingerprint === "string" ? { fingerprint: body.approvalFingerprint } : {}),
  }
}

function gateAgentAction(
  context: ApiContext,
  request: IncomingMessage,
  body: Record<string, unknown>,
  action: string,
  resource: string,
  required: readonly OmniaScope[],
): { status: number; result: Record<string, unknown> } | undefined {
  if (!isAgentRequest(context, request, body)) return undefined
  const operation: OperationInput = {
    action,
    resources: [resource],
    ...(typeof body.command === "string" ? { command: body.command } : {}),
  }
  const sessionId = requestSessionId(request, body)
  const decision = context.permissions.evaluate(required, {
    ...(sessionId === undefined ? {} : { sessionId }),
    approval: approvalFromBody(context, request, body),
    operation,
  })
  if (decision.allowed) return undefined
  return {
    status: decision.status === "denied" ? 403 : 428,
    result: {
      success: false,
      status: "rejected",
      message: decision.reason ?? "Permission required.",
      error: {
        code: decision.status === "denied" ? "permission_denied" : "permission_required",
        message: decision.reason ?? "Permission required.",
        retryable: decision.status !== "denied",
        details: { missing: decision.missing, fingerprint: operationFingerprint(operation) },
      },
    },
  }
}

function operatorOnly(
  context: Pick<ApiContext, "token">,
  request: IncomingMessage,
  body: Record<string, unknown> = {},
): boolean {
  return isOperatorRequest(context, request, body)
}

function operatorDenied(
  context: Pick<ApiContext, "token">,
  request: IncomingMessage,
  body: Record<string, unknown> = {},
): { status: number; payload: Record<string, unknown> } | undefined {
  if (operatorOnly(context, request, body)) return undefined
  return {
    status: 403,
    payload: { ok: false, error: "Only the desktop operator can manage models, runtimes, and sign-in." },
  }
}

// Billing enforcement for this route table.
//
// The plan matrix in ../billing/plans is the only source of truth for what a
// plan may do, and the control plane (POST /v1/billing/check) is the only
// authority that can answer it. These gates run BEFORE the work they guard: a
// refusal that arrives after the grab is installed is not a refusal, it is
// somebody's keyboard held until they pay.
//
// The failure policy is inherited from the plan table rather than re-decided
// here, and the two directions are deliberately opposite:
//
//   - A CONFIGURED control plane that cannot be reached means the usage counters
//     are unknown, so a hard-metered capability fails closed and a soft-metered
//     one keeps working. That is failsClosed(), not a judgement call made here.
//   - An install with NO control plane configured has no billing relationship at
//     all, so there is nothing to enforce and the gate is inert. Refusing there
//     would break every local and self-hosted install that never opted into
//     billing, which is the same split computers.ts makes.
//
// Every call carries an AbortSignal.timeout because a hung control plane must
// never become the user's latency; past the deadline the failure policy above
// decides.
export const CAPABILITY_CHECK_TIMEOUT_MS = 5_000

/** How a capability is named to the person who just got refused. */
const CAPABILITY_LABELS: Readonly<Partial<Record<Capability, string>>> = {
  input_freeze: "Freezing physical input",
}

function billingControlPlane(): { readonly base: string; readonly token: string } | undefined {
  // The same resolution the browser, CUA and driver gates use: OMNIA_SERVER_URL
  // wins, OMNIA_PUBLIC_URL is the fallback, and no token means inert. A host with
  // no usable port is deliberately NOT guessed into port 80 - shipping the bearer
  // somewhere unintended is worse than having no gate at all.
  const token = process.env.OMNIA_SERVER_TOKEN ?? ""
  if (token.length === 0) return undefined
  const configured = process.env.OMNIA_SERVER_URL ?? process.env.OMNIA_PUBLIC_URL
  if (configured === undefined || configured.length === 0) return undefined
  return { base: configured.replace(/\/+$/, ""), token }
}

/**
 * Asks the control plane whether this plan may use `capability`, before the
 * caller does anything with it. Returns undefined when the request may proceed.
 *
 * A refusal is a typed, descriptive failure that names the capability and the
 * plan the customer is actually on. It is deliberately never an empty result: a
 * caller handed `{ frozen: false }` or an empty list cannot tell "you are not
 * allowed to do this" from "there was nothing to do", so it retries forever or
 * reports a bogus success - both of which turn a paid capability into a free one.
 */
async function capabilityDenied(
  context: Pick<ApiContext, "auth">,
  capability: Capability,
): Promise<{ status: number; payload: Record<string, unknown> } | undefined> {
  const controlPlane = billingControlPlane()
  if (controlPlane === undefined) return undefined
  // Entitlements are per profile, so a signed-in customer has to be checked
  // against THEIR plan rather than against the anonymous free one. Only the
  // server's own signed-in profile is forwarded: a caller-supplied
  // x-omnia-profile header is not an identity, and the control plane only
  // honours that header from a caller that presented the server token anyway.
  const profile = context.auth.status().profile
  let body: unknown
  // The plan the control plane last reported for this caller, so a failure later
  // in this function can be judged against the right one.
  let lastKnownPlan: PlanId | undefined
  try {
    const response = await fetch(`${controlPlane.base}/v1/billing/check`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${controlPlane.token}`,
        "content-type": "application/json",
        ...(profile === undefined ? {} : { "x-omnia-profile": String(profile.id) }),
      },
      // The body is the capability and nothing else: no computer id, no reason,
      // nothing that would have to be redacted before it is sent or logged.
      body: JSON.stringify({ capability }),
      signal: AbortSignal.timeout(CAPABILITY_CHECK_TIMEOUT_MS),
    })
    // 402 is a decision and is parsed below. Any other status - a 5xx, a 401
    // from a rotated token - is the control plane failing rather than deciding.
    // Reading that as "not included in your plan" both lies to the customer and
    // applies free-plan policy to someone who paid.
    if (response.status !== 200 && response.status !== 402) {
      return unconfirmed(capability, `the billing service answered HTTP ${response.status}`, lastKnownPlan)
    }
    body = await response.json().catch(() => undefined)
    if (isRecord(body) && isPlanId(body.plan)) lastKnownPlan = body.plan
  } catch {
    return unconfirmed(capability, "the billing service could not be reached", lastKnownPlan)
  }
  // The reply is untrusted: an `allowed: true` is honoured only when the shape
  // also agrees which capability it is talking about, so a replayed or proxied
  // answer for a different capability cannot grant this one.
  if (!isRecord(body) || typeof body.allowed !== "boolean" || body.capability !== capability) {
    return unconfirmed(capability, "the billing service returned an unreadable answer", lastKnownPlan)
  }
  if (body.allowed) return undefined
  const plan = isPlanId(body.plan) ? body.plan : "free"
  const reason =
    typeof body.reason === "string" && body.reason.length > 0
      ? body.reason
      : `${capability} is not included in the ${plan} plan.`
  return {
    status: 402,
    payload: {
      ok: false,
      error: {
        code: "capability_not_entitled",
        // The capability and the plan are both named on purpose: a refusal the
        // user cannot act on is a support ticket instead of an upgrade.
        message: `${reason} (${capability}, plan: ${plan})`,
        capability,
        plan,
        // Upgrading fixes this one. Retrying does not.
        retryable: false,
      },
    },
  }
}

/**
 * The refusal for a capability whose allowance could not be established.
 *
 * `failsClosed` picks the direction, so this is not a policy decision made at the
 * call site: a hard allowance cannot be honoured with an unknown counter and is
 * refused as retryable (waiting fixes it), while a soft allowance keeps working
 * so a billing outage never takes a capability away from someone entitled to it.
 * Returns undefined in the fail-open case, which lets the caller proceed.
 */
function unconfirmed(
  capability: Capability,
  cause: string,
  plan?: PlanId,
): { status: number; payload: Record<string, unknown> } | undefined {
  // Evaluated against the plan the customer is actually on. Defaulting to `free`
  // here meant a paying customer lost a paid capability on any control-plane
  // hiccup - the fifth copy of the bug that plans.ts was fixed for.
  if (!failsClosed(capability, plan ?? "free")) return undefined
  const label = CAPABILITY_LABELS[capability] ?? capability
  return {
    status: 503,
    payload: {
      ok: false,
      error: {
        code: "entitlement_unavailable",
        message: `${label} could not be confirmed because ${cause}, so it is refused rather than served unmetered. Nothing was performed.`,
        capability,
        plan: "free",
        retryable: true,
      },
    },
  }
}

function dragEndpoint(value: unknown): ServerActionRequest["from"] {
  if (!isRecord(value)) return undefined
  const x = finiteNumber(value.x)
  const y = finiteNumber(value.y)
  const endpoint = {
    ...(typeof value.elementId === "string" && value.elementId.length > 0 ? { elementId: value.elementId } : {}),
    ...(x === undefined ? {} : { x }),
    ...(y === undefined ? {} : { y }),
  }
  return Object.keys(endpoint).length === 0 ? undefined : endpoint
}

// Window management (tile, move, maximize, minimize, restore, close) resolved
// through the Cua engine so it works for both AT-SPI and X11-only windows.
// Only these window_* actions exist. Anything else must 400 rather than
// falling through to window_close under the wrong scope.
// Empty scope arrays on a superskill are a declaration of "no scopes", which
// must not weaken the bridge's inherent PROCESS_EXECUTE/NETWORK boundary.
function superskillScopes(bridgeType: unknown): readonly OmniaScope[] {
  return bridgeType === "stdio" ? ["PROCESS_EXECUTE"] : ["NETWORK"]
}

function calibrationMeasurements(value: unknown): CalibrationMeasurement[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): CalibrationMeasurement[] => {
    if (!isRecord(entry)) return []
    const x = finiteNumber(entry.x)
    const y = finiteNumber(entry.y)
    if (typeof entry.pointId !== "string" || x === undefined || y === undefined) return []
    const observedX = finiteNumber(entry.observedX)
    const observedY = finiteNumber(entry.observedY)
    return [
      {
        pointId: entry.pointId,
        x,
        y,
        ...(observedX === undefined ? {} : { observedX }),
        ...(observedY === undefined ? {} : { observedY }),
        ...(finiteNumber(entry.deltaX) === undefined ? {} : { deltaX: finiteNumber(entry.deltaX)! }),
        ...(finiteNumber(entry.deltaY) === undefined ? {} : { deltaY: finiteNumber(entry.deltaY)! }),
        ...(typeof entry.error === "string" ? { error: entry.error } : {}),
      },
    ]
  })
}

// A corrupt affine profile would misdirect every future click, so the scale
// and offset are bounded to plausible display values before saving.
function clampCalibrationProfile(profile: CalibrationProfile): CalibrationProfile {
  const clamp = (value: number, min: number, max: number, fallback: number) =>
    Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
  return {
    ...profile,
    scaleX: clamp(profile.scaleX, 0.1, 10, 1),
    scaleY: clamp(profile.scaleY, 0.1, 10, 1),
    offsetX: clamp(profile.offsetX, -100_000, 100_000, 0),
    offsetY: clamp(profile.offsetY, -100_000, 100_000, 0),
  }
}

// Window management lives on the ComputerManager now so batch steps and the
// standalone route share one implementation; the constant is re-exported here
// for callers that import the API surface.
export { WINDOW_ACTION_SCOPES } from "./computers"

// Point targets pass through the display calibration profile so pointer input
// lands on the intended pixel even under DPI scaling or compositor offsets.
function calibrateFields(
  calibration: CalibrationManager,
  fields: Omit<ServerActionRequest, "action">,
): Omit<ServerActionRequest, "action"> {
  const point = (x: number | undefined, y: number | undefined) =>
    typeof x === "number" && typeof y === "number" ? calibration.transform(x, y) : undefined
  const target = point(fields.x, fields.y)
  const drag = (endpoint: DragEndpoint | undefined) =>
    endpoint === undefined || typeof endpoint.x !== "number" || typeof endpoint.y !== "number"
      ? endpoint
      : calibration.transform(endpoint.x, endpoint.y)
  const from = drag(fields.from)
  const to = drag(fields.to)
  return {
    ...fields,
    ...(target === undefined ? {} : { x: target.x, y: target.y }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  }
}

// Empty element ids must never be materialized: a driver that receives
// elementId:"" would treat it as a real reference instead of resolving the
// observation-scoped target. Only non-empty ids are carried.
function actionTarget(value: unknown): ElementReference | undefined {
  if (!isRecord(value)) return undefined
  const elementId = typeof value.elementId === "string" && value.elementId.length > 0 ? value.elementId : undefined
  const observationId =
    typeof value.observationId === "string" && value.observationId.length > 0 ? value.observationId : undefined
  if (elementId !== undefined) {
    return { kind: "element", elementId, ...(observationId === undefined ? {} : { observationId }) }
  }
  if (observationId === undefined) return undefined
  // An observation-scoped reference carries no element id; the driver resolves
  // it against the referenced observation. The protocol union will grow the
  // matching observationId-only variant on the computers.ts side.
  return { kind: "element", observationId } as ElementReference
}

function actionBounds(value: unknown): Bounds | undefined {
  if (!isRecord(value)) return undefined
  const x = finiteNumber(value.x)
  const y = finiteNumber(value.y)
  const width = finiteNumber(value.width, { min: 1, max: 100_000 })
  const height = finiteNumber(value.height, { min: 1, max: 100_000 })
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined
  return { x, y, width, height }
}

function actionFields(record: Record<string, unknown>, mayApprove: boolean): Omit<ServerActionRequest, "action"> {
  const scopes = mayApprove ? asStringArray(record.approvedScopes)?.filter(isOmniaScope) : undefined
  const from = dragEndpoint(record.from)
  const to = dragEndpoint(record.to)
  const target = actionTarget(record.target)
  const region = actionBounds(record.region)
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(target === undefined ? {} : { target }),
    ...(region === undefined ? {} : { region }),
    ...(typeof record.query === "string" ? { query: record.query } : {}),
    ...(typeof record.role === "string" ? { role: record.role } : {}),
    ...(typeof record.window === "string" ? { window: record.window } : {}),
    ...(typeof record.tab === "string" ? { tab: record.tab } : {}),
    // browser_dialog: which answer to give and the fail-closed expectation the
    // pending dialog must still match.
    ...(typeof record.dialog === "string" ? { dialog: record.dialog } : {}),
    ...(typeof record.promptText === "string" ? { promptText: record.promptText } : {}),
    ...(typeof record.expectedType === "string" ? { expectedType: record.expectedType } : {}),
    ...(typeof record.expectedMessage === "string" ? { expectedMessage: record.expectedMessage } : {}),
    // Preserve the observation binding for staleness enforcement. Both the
    // top-level observationId and target.observationId (via actionTarget) are
    // carried; a mismatch answers target_stale instead of acting stale.
    ...(typeof record.observationId === "string" && record.observationId.length > 0
      ? { observationId: record.observationId }
      : {}),
    // Browser read paging: offset/maxChars are forwarded to the runtime so it
    // answers real paging metadata instead of silently slicing.
    ...(finiteNumber(record.offset, { min: 0, max: 10_000_000 }) === undefined
      ? {}
      : { offset: finiteNumber(record.offset, { min: 0, max: 10_000_000 })! }),
    ...(finiteNumber(record.maxChars, { min: 1, max: 1_000_000 }) === undefined
      ? {}
      : { maxChars: finiteNumber(record.maxChars, { min: 1, max: 1_000_000 })! }),
    ...(typeof record.text === "string" ? { text: record.text } : {}),
    ...(typeof record.value === "string" ? { value: record.value } : {}),
    ...(typeof record.start === "string" ? { start: record.start } : {}),
    ...(typeof record.stop === "string" ? { stop: record.stop } : {}),
    ...(typeof record.endKey === "string" ? { endKey: record.endKey } : {}),
    ...(typeof record.key === "string" ? { key: record.key } : {}),
    ...(asStringArray(record.keys) === undefined ? {} : { keys: asStringArray(record.keys)! }),
    ...(typeof record.app === "string" ? { app: record.app } : {}),
    ...(typeof record.url === "string" ? { url: record.url } : {}),
    ...(typeof record.path === "string" ? { path: record.path } : {}),
    ...(typeof record.direction === "string" ? { direction: record.direction } : {}),
    ...(finiteNumber(record.amount, { min: 0, max: 1_000_000 }) === undefined
      ? {}
      : { amount: finiteNumber(record.amount, { min: 0, max: 1_000_000 })! }),
    ...(finiteNumber(record.limit, { min: 0, max: 1000 }) === undefined
      ? {}
      : { limit: finiteNumber(record.limit, { min: 0, max: 1000 })! }),
    // browser_upload: absolute paths of files to attach to the pending file
    // chooser. Bounded to 10 entries; non-string entries are dropped here and
    // the action fails closed below when nothing usable remains.
    ...(asStringArray(record.files) === undefined ? {} : { files: asStringArray(record.files)!.slice(0, 10) }),
    ...(typeof record.button === "string" ? { button: record.button } : {}),
    ...(typeof record.command === "string" ? { command: record.command } : {}),
    ...(typeof record.cwd === "string" ? { cwd: record.cwd } : {}),
    ...(finiteNumber(record.timeoutMs, { min: 0, max: 600_000 }) === undefined
      ? {}
      : { timeoutMs: finiteNumber(record.timeoutMs, { min: 0, max: 600_000 })! }),
    ...(typeof record.credential === "string" ? { credential: record.credential } : {}),
    ...(record.field === "username" || record.field === "secret" ? { field: record.field } : {}),
    ...(typeof record.username === "string" ? { username: record.username } : {}),
    ...(typeof record.password === "string" ? { password: record.password } : {}),
    ...(typeof record.expectedHost === "string" ? { expectedHost: record.expectedHost } : {}),
    ...(typeof record.usernameField === "string" ? { usernameField: record.usernameField } : {}),
    ...(typeof record.passwordField === "string" ? { passwordField: record.passwordField } : {}),
    ...(record.identifierFirst === true ? { identifierFirst: true } : {}),
    ...(record.submit === false ? { submit: false } : {}),
    // browser_login: the caller states what a signed-in page looks like so the
    // action can prove the login instead of guessing from a URL change.
    ...(isRecord(record.expect)
      ? {
          expect: {
            ...(typeof record.expect.text === "string" ? { text: record.expect.text } : {}),
            ...(typeof record.expect.urlContains === "string" ? { urlContains: record.expect.urlContains } : {}),
          },
        }
      : {}),
    ...(typeof record.doc === "string" ? { doc: record.doc } : {}),
    ...(typeof record.sheet === "string" ? { sheet: record.sheet } : {}),
    ...(typeof record.range === "string" ? { range: record.range } : {}),
    ...(typeof record.cell === "string" ? { cell: record.cell } : {}),
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    ...(typeof record.type === "string" ? { type: record.type } : {}),
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    ...(typeof record.bold === "boolean" ? { bold: record.bold } : {}),
    ...(typeof record.background === "string" ? { background: record.background } : {}),
    ...(typeof record.wrap === "boolean" ? { wrap: record.wrap } : {}),
    ...(finiteNumber(record.fontSize, { min: 1, max: 512 }) === undefined
      ? {}
      : { fontSize: finiteNumber(record.fontSize, { min: 1, max: 512 })! }),
    ...(finiteNumber(record.index, { min: 0 }) === undefined ? {} : { index: finiteNumber(record.index, { min: 0 })! }),
    ...(finiteNumber(record.count, { min: 1, max: 10 }) === undefined
      ? {}
      : { count: finiteNumber(record.count, { min: 1, max: 10 })! }),
    ...(finiteNumber(record.width, { min: 1, max: 100_000 }) === undefined
      ? {}
      : { width: finiteNumber(record.width, { min: 1, max: 100_000 })! }),
    ...(finiteNumber(record.height, { min: 1, max: 100_000 }) === undefined
      ? {}
      : { height: finiteNumber(record.height, { min: 1, max: 100_000 })! }),
    ...(Array.isArray(record.rows)
      ? {
          rows: record.rows
            .filter((row): row is unknown[] => Array.isArray(row))
            .map((row) => row.filter((value): value is string | number | boolean | null => value === null || ["string", "number", "boolean"].includes(typeof value))),
        }
      : {}),
    ...(Array.isArray(record.items)
      ? {
          items: record.items.flatMap((item) =>
            isRecord(item) && typeof item.text === "string"
              ? [{ text: item.text, ...(typeof item.style === "string" ? { style: item.style } : {}) }]
              : [],
          ),
        }
      : {}),
    ...(finiteNumber(record.x, { min: -1_000_000, max: 1_000_000 }) === undefined
      ? {}
      : { x: finiteNumber(record.x, { min: -1_000_000, max: 1_000_000 })! }),
    ...(finiteNumber(record.y, { min: -1_000_000, max: 1_000_000 }) === undefined
      ? {}
      : { y: finiteNumber(record.y, { min: -1_000_000, max: 1_000_000 })! }),
    // The approval claim is forwarded solely for a server-token caller, which
    // covers both the desktop UI and the agent runtime that shares its token. A
    // client token keeps approvalFingerprint, which is proof this server issued.
    ...(mayApprove && record.approve === true ? { approve: true } : {}),
    ...(typeof record.approvedBy === "string" ? { approvedBy: record.approvedBy } : {}),
    ...(scopes === undefined ? {} : { approvedScopes: scopes }),
    ...(typeof record.approvalFingerprint === "string" ? { approvalFingerprint: record.approvalFingerprint } : {}),
    ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
  }
}

function parseBatchStep(record: Record<string, unknown>, mayApprove: boolean): ServerBatchStep | undefined {
  if (typeof record.action !== "string") return undefined
  const expect = isRecord(record.expect)
    ? {
        ...(typeof record.expect.text === "string" ? { text: record.expect.text } : {}),
        ...(typeof record.expect.window === "string" ? { window: record.expect.window } : {}),
        ...(typeof record.expect.file === "string" ? { file: record.expect.file } : {}),
      }
    : undefined
  return {
    action: record.action,
    ...actionFields(record, mayApprove),
    ...(expect === undefined || Object.keys(expect).length === 0 ? {} : { expect }),
    // Per-step fail-closed escape. Default false: an unverified step fails
    // unless the caller explicitly passes allowUnverified:true for that step.
    ...(record.allowUnverified === true ? { allowUnverified: true } : {}),
  }
}

// Remote runtimes authenticate every request with a per-computer Ed25519
// signature on top of the bearer token. The signed path includes the query
// string, and the raw body is hashed exactly as it arrived, so tampering with
// either invalidates the signature.
async function authorizeRemoteRequest(
  context: ApiContext,
  request: IncomingMessage,
  parsed: ParsedRequest,
  computerId: string,
  body: Buffer,
): Promise<boolean> {
  const keyId = request.headers[REMOTE_KEY_ID_HEADER]
  const timestamp = request.headers[REMOTE_TIMESTAMP_HEADER]
  const signature = request.headers[REMOTE_SIGNATURE_HEADER]
  if (typeof keyId !== "string" || typeof timestamp !== "string" || typeof signature !== "string") return false
  if (keyId !== computerId) return false
  return context.remote.verifyRequest(computerId, {
    method: parsed.method,
    path: parsed.url.pathname + parsed.url.search,
    timestampMs: Number(timestamp),
    body,
    signature,
  })
}

function remoteUnauthenticated(response: ServerResponse): void {
  json(response, 401, { ok: false, error: "remote_unauthenticated" })
}

export async function handleRequest(context: ApiContext, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const parsed = parseRequest(request)
  if (parsed.method === "OPTIONS") {
    json(response, 204, {})
    return true
  }

  const segments = parsed.segments
  if (segments[0] !== "v1") return false

  // Header-only session binding is verified before any route runs so requests
  // that never read a body (GET/DELETE) cannot smuggle an unbound session.
  // Body sessionIds are checked by readBoundBody at each route.
  checkSessionBinding(context, request)

  if (parsed.method === "GET" && segments.length === 2 && segments[1] === "health") {
    json(response, 200, { ok: true, health: context.health() })
    return true
  }

  if (parsed.method === "GET" && segments.length === 2 && segments[1] === "capabilities") {
    const computers = await context.computers.list()
    json(response, 200, {
      ok: true,
      server: context.descriptor,
      protocol: OMNIA_PROTOCOL_VERSION,
      computers: computers.map((computer) => ({
        id: computer.id,
        platform: computer.platform,
        backend: computer.backend,
        connected: computer.connected,
        capabilities: computer.capabilities,
      })),
    })
    return true
  }

  if (parsed.method === "GET" && segments.length === 2 && segments[1] === "actions") {
    const format = parsed.url.searchParams.get("format") ?? "json"
    if (format === "text" || format === "markdown") {
      const body = renderCatalogText()
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      })
      response.end(body)
      return true
    }
    if (format === "openai") {
      json(response, 200, { ok: true, protocol: OMNIA_PROTOCOL_VERSION, tools: renderOpenAiTools() })
      return true
    }
    if (format === "anthropic") {
      json(response, 200, { ok: true, protocol: OMNIA_PROTOCOL_VERSION, tools: renderAnthropicTools() })
      return true
    }
    json(response, 200, {
      ok: true,
      protocol: OMNIA_PROTOCOL_VERSION,
      actions: OMNIA_ACTION_CATALOG,
      batch: { endpoint: "POST /v1/computers/:id/do", fields: ["steps", "stopOnError", "approve", "sessionId"] },
      text: { endpoint: "POST /v1/computers/:id/text", fields: ["script", "stopOnError", "approve", "sessionId"] },
      formats: ["json", "text", "openai", "anthropic"],
    })
    return true
  }

  if (parsed.method === "GET" && segments.length === 2 && segments[1] === "computers") {
    json(response, 200, { ok: true, computers: await context.computers.list() })
    return true
  }

  if (segments.length >= 3 && segments[1] === "computers" && segments[2] === "pair") {
    if (parsed.method === "GET" && segments.length === 3) {
      json(response, 200, { ok: true, pairings: context.pairings.list(), serverUrl: context.pairingUrl() })
      return true
    }
    if (parsed.method === "POST" && segments.length === 3) {
      const body = (await readBoundBody(context, request)) as Record<string, unknown> | undefined
      const offer = context.pairings.create(
        isRecord(body) && typeof body.name === "string" && body.name.trim().length > 0 ? { name: body.name.trim() } : {},
      )
      context.events.emit("computer.pairing_created", { data: { code: offer.code, expiresAt: offer.expiresAt } })
      const serverUrl = context.pairingUrl()
      json(response, 200, {
        ok: true,
        pairing: offer,
        serverUrl,
        pairingCode: formatPairingCode(serverUrl, offer.code),
      })
      return true
    }
    if (parsed.method === "DELETE" && segments.length === 4) {
      let code: string
      try {
        code = decodeURIComponent(segments[3]!)
      } catch {
        json(response, 400, { ok: false, error: "The pairing code in the path is not valid percent-encoding." })
        return true
      }
      const removed = context.pairings.cancel(code)
      if (removed) context.events.emit("computer.pairing_cancelled", { data: { code } })
      json(response, removed ? 200 : 404, {
        ok: removed,
        ...(removed ? {} : { error: `No pairing offer ${code}.` }),
      })
      return true
    }
    if (parsed.method === "POST" && segments.length === 4 && segments[3] === "claim") {
      const body = (await readBoundBody(context, request)) as Record<string, unknown> | undefined
      const code = isRecord(body) && typeof body.code === "string" ? body.code : ""
      // Validate the key before consuming the single-use code so a malformed
      // claim does not burn the offer.
      const publicKeyInput = isRecord(body) ? body.publicKey : undefined
      const publicKey = publicKeyInput === undefined ? undefined : parseRemotePublicKey(publicKeyInput)
      if (publicKeyInput !== undefined && publicKey === undefined) {
        json(response, 400, {
          ok: false,
          error: "The publicKey must be an Ed25519 JWK or a base64-encoded 32-byte raw public key.",
        })
        return true
      }
      const offerStatus = context.pairings.status(code)
      if (offerStatus === "expired") {
        json(response, 410, {
          ok: false,
          error: "That pairing code expired. Generate a new code on the other computer.",
          code: "pairing_expired",
        })
        return true
      }
      const offer = context.pairings.claim(code)
      if (offer === undefined) {
        json(response, 404, {
          ok: false,
          error: "The pairing code is unknown. Check the code or generate a new one on the other computer.",
          code: "pairing_not_found",
        })
        return true
      }
      const name =
        isRecord(body) && typeof body.name === "string" && body.name.trim().length > 0
          ? body.name.trim()
          : offer.name ?? "Remote computer"
      const platform =
        isRecord(body) && typeof body.platform === "string" && body.platform.length > 0 ? body.platform : "unknown"
      const architecture = isRecord(body) && typeof body.architecture === "string" ? body.architecture : undefined
      const info: ComputerInfo | undefined =
        isRecord(body) && isComputerInfo(body.info) ? body.info : undefined
      const capabilities: readonly CapabilitySupport[] | undefined =
        isRecord(body) && Array.isArray(body.capabilities) && body.capabilities.every(isCapabilitySupport)
          ? body.capabilities
          : undefined
      const claimed = context.remote.claim({
        name,
        platform,
        ...(architecture === undefined ? {} : { architecture }),
        ...(info === undefined ? {} : { info }),
        ...(capabilities === undefined ? {} : { capabilities }),
        ...(publicKey === undefined ? {} : { publicKey }),
      })
      context.events.emit("computer.pairing_claimed", {
        computerId: claimed.computerId,
        data: { code: offer.code, name },
      })
      json(response, 200, { ok: true, computerId: claimed.computerId, token: claimed.token, name })
      return true
    }
    json(response, 404, { ok: false, error: "Unknown pairing route." })
    return true
  }

  if (segments.length === 3 && segments[1] === "computers" && segments[2] === "register" && parsed.method === "POST") {
    const presented = bearerToken(request)
    if (presented === undefined || (context.auth.isClientToken(presented) === false && !presentsServerToken(context, request))) {
      json(response, 401, { ok: false, error: "client_token_required" })
      return true
    }
    const body = (await readBody(request)) as Record<string, unknown> | undefined
    const record = isRecord(body) ? body : {}
    const name = typeof record.name === "string" ? record.name.trim() : ""
    const platform = typeof record.platform === "string" ? record.platform.trim() : ""
    if (name.length === 0 || platform.length === 0) {
      json(response, 400, { ok: false, error: "A non-empty name and platform are required." })
      return true
    }
    const publicKey = parseRemotePublicKey(record.publicKey)
    if (publicKey === undefined) {
      json(response, 400, {
        ok: false,
        error: "The publicKey must be an Ed25519 JWK or a base64-encoded 32-byte raw public key.",
      })
      return true
    }
    const info = isComputerInfo(record.info) ? record.info : undefined
    if (record.info !== undefined && info === undefined) {
      json(response, 400, { ok: false, error: "The info field must be a valid computer info object." })
      return true
    }
    const capabilities =
      Array.isArray(record.capabilities) && record.capabilities.every(isCapabilitySupport)
        ? record.capabilities
        : undefined
    if (record.capabilities !== undefined && capabilities === undefined) {
      json(response, 400, { ok: false, error: "The capabilities field must be a valid capability support list." })
      return true
    }
    const claimed = context.remote.claim({
      name,
      platform,
      ...(typeof record.architecture === "string" ? { architecture: record.architecture } : {}),
      ...(info === undefined ? {} : { info }),
      ...(capabilities === undefined ? {} : { capabilities }),
      publicKey,
      ...(typeof record.computerId === "string" && record.computerId.length > 0
        ? { reuseId: record.computerId }
        : {}),
    })
    json(response, 200, { ok: true, computerId: claimed.computerId, token: claimed.token })
    return true
  }

  if (segments.length >= 4 && segments[1] === "computers") {
    const computerId = segments[2]!
    const action = segments[3]!
    const computer = context.computers.get(computerId)
    if (!computer) {
      json(response, 404, { ok: false, error: `Unknown computer ${computerId}.` })
      return true
    }
    if (segments.length === 5 && segments[4] === "commands" && parsed.method === "GET") {
      if (!(await authorizeRemoteRequest(context, request, parsed, computerId, Buffer.alloc(0)))) {
        remoteUnauthenticated(response)
        return true
      }
      const waitParam = Number(parsed.url.searchParams.get("wait") ?? "25000")
      const waitMs = Number.isFinite(waitParam) ? Math.max(0, Math.min(waitParam, 50000)) : 25000
      const command = await context.remote.next(computerId, waitMs)
      json(response, 200, { ok: true, command: command ?? null })
      return true
    }
    if (segments.length === 5 && segments[4] === "results" && parsed.method === "POST") {
      const raw = await readBodyBytes(request)
      if (!(await authorizeRemoteRequest(context, request, parsed, computerId, raw))) {
        remoteUnauthenticated(response)
        return true
      }
      const body = parseBodyBytes(raw) as Record<string, unknown> | undefined
      checkSessionBinding(context, request, isRecord(body) ? body : undefined)
      const id = isRecord(body) && typeof body.id === "string" ? body.id : ""
      const accepted = context.remote.complete(computerId, {
        id,
        ok: isRecord(body) && body.ok === true,
        ...(isRecord(body) && "result" in body ? { result: body.result } : {}),
        ...(isRecord(body) && typeof body.error === "string" ? { error: body.error } : {}),
        // The typed runtime code has to cross this boundary too, otherwise the
        // caller only sees a generic remote failure instead of the taxonomy.
        ...(isRecord(body) && typeof body.code === "string" && body.code.length > 0 ? { code: body.code } : {}),
      })
      json(response, accepted ? 200 : 404, { ok: accepted })
      return true
    }
    if (segments.length === 5 && segments[4] === "bye" && parsed.method === "POST") {
      const raw = await readBodyBytes(request)
      if (!(await authorizeRemoteRequest(context, request, parsed, computerId, raw))) {
        remoteUnauthenticated(response)
        return true
      }
      const removed = context.remote.bye(computerId)
      json(response, 200, { ok: removed })
      return true
    }
    if (parsed.method === "GET" && segments.length === 4 && action === "capabilities") {
      json(response, 200, { ok: true, capabilities: await context.computers.capabilities(computerId) })
      return true
    }
    if (parsed.method === "POST" && segments.length === 4 && action === "observe") {
      const body = (await readBoundBody(context, request)) as
        | { applicationId?: unknown; includeScreenshot?: unknown; window?: unknown }
        | undefined
      const denied = gateAgentAction(
        context,
        request,
        isRecord(body) ? body : {},
        "observe",
        computerId,
        requiredScopesForAction("observe"),
      )
      if (denied !== undefined) {
        json(response, denied.status, { ok: false, result: denied.result })
        return true
      }
      const observation = await context.computers.observe(computerId, {
        ...(typeof body?.applicationId === "string" ? { applicationId: body.applicationId } : {}),
        ...(body?.includeScreenshot === true ? { includeScreenshot: true } : {}),
      })
      const windowFragment =
        typeof body?.window === "string" && body.window.trim().length > 0 ? body.window.trim().toLowerCase() : undefined
      if (windowFragment === undefined || observation === undefined) {
        json(response, 200, { ok: true, observation })
        return true
      }
      const elements = observation.elements ?? []
      const windowElement = elements.find(
        (element) =>
          element.role === "window" &&
          (String(element.name ?? "").toLowerCase().includes(windowFragment) ||
            String(element.metadata?.application ?? "").toLowerCase().includes(windowFragment)),
      )
      if (windowElement?.id === undefined) {
        json(response, 404, {
          ok: false,
          error: {
            code: "window_not_found",
            message: `No window matches "${body?.window}".`,
            details: {
              windows: elements
                .filter((element) => element.role === "window")
                .flatMap((element) => (typeof element.name === "string" ? [element.name] : []))
                .slice(0, 10),
            },
          },
        })
        return true
      }
      const windowRef = windowElement.id
      const filtered = elements.filter(
        (element) =>
          element.id === windowRef ||
          String(element.metadata?.windowRef ?? "") === windowRef ||
          String(element.id ?? "").startsWith(`${windowRef}/`),
      )
      json(response, 200, { ok: true, observation: { ...observation, elements: filtered } })
      return true
    }
    if (parsed.method === "POST" && segments.length === 4 && action === "find") {
      const body = (await readBoundBody(context, request)) as Record<string, unknown> | undefined
      if (!isRecord(body) || typeof body.query !== "string" || body.query.trim().length === 0) {
        json(response, 400, { ok: false, error: "Find requires a non-empty query." })
        return true
      }
      const denied = gateAgentAction(
        context,
        request,
        body,
        "find",
        computerId,
        requiredScopesForAction("find"),
      )
      if (denied !== undefined) {
        json(response, denied.status, { ok: false, result: denied.result })
        return true
      }
      const result = await context.computers.find(computerId, {
        query: body.query,
        ...(typeof body.role === "string" ? { role: body.role } : {}),
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(typeof body.window === "string" ? { window: body.window } : {}),
        ...(finiteNumber(body.limit, { min: 1, max: 1000 }) === undefined
          ? {}
          : { limit: finiteNumber(body.limit, { min: 1, max: 1000 })! }),
      })
      json(response, 200, { ok: true, result })
      return true
    }
    if (parsed.method === "POST" && segments.length === 4 && action === "actions") {
      const body = (await readBoundBody(context, request)) as Record<string, unknown> | undefined
      if (!isRecord(body) || typeof body.action !== "string") {
        json(response, 400, { ok: false, error: "An action is required." })
        return true
      }
      const sessionId = requestSessionId(request, body)
      const fields = {
        ...actionFields(body, presentsServerToken(context, request)),
        ...(sessionId === undefined ? {} : { sessionId }),
        // The desktop UI is the approver for its own actions; every other
        // caller is forwarded as agent so the ComputerManager gates it even
        // when it claimed no session and no origin header.
        ...(isOperatorRequest(context, request, body) ? {} : { origin: "agent" as const }),
      }
      // Browser coordinates are page pixels, not screen pixels; window
      // management and calibration address the screen/driver directly. Desktop
      // calibration must never be applied to any of them.
      const calibrated =
        body.action.startsWith("browser_") ||
        body.action.startsWith("window_") ||
        body.action.startsWith("calibration_")
          ? fields
          : calibrateFields(context.calibration, fields)
      const outcome = await context.computers.execute(computerId, {
        action: body.action,
        ...calibrated,
      })
      json(response, outcome.httpStatus, { ok: outcome.result.success, result: outcome.result })
      return true
    }
    if (segments.length === 5 && action === "cua") {
      return handleCuaRequest(context, request, response, computerId, segments[4]!, parsed.method)
    }
    if (parsed.method === "POST" && segments.length === 4 && action === "text") {
      const body = (await readBoundBody(context, request)) as Record<string, unknown> | undefined
      if (!isRecord(body) || typeof body.script !== "string" || body.script.trim().length === 0) {
        json(response, 400, { ok: false, error: "A non-empty script is required." })
        return true
      }
      const parsedScript = parseActionScript(body.script)
      if (parsedScript.errors.length > 0) {
        json(response, 400, {
          ok: false,
          error: "The action script has invalid lines; nothing was executed.",
          errors: parsedScript.errors,
        })
        return true
      }
      if (parsedScript.steps.length === 0) {
        json(response, 400, { ok: false, error: "The action script contained no actions." })
        return true
      }
      let scriptCancelled = false
      response.on("close", () => {
        if (!response.writableEnded) scriptCancelled = true
      })
      const operator = isOperatorRequest(context, request, body)
      const mayApprove = presentsServerToken(context, request)
      const outcome = await context.computers.executeBatch(computerId, {
        steps: parsedScript.steps,
        shouldStop: () => scriptCancelled,
        ...(typeof body.stopOnError === "boolean" ? { stopOnError: body.stopOnError } : {}),
        ...(mayApprove && body.approve === true ? { approve: true } : {}),
        ...(typeof body.approvedBy === "string" ? { approvedBy: body.approvedBy } : {}),
        ...(mayApprove && asStringArray(body.approvedScopes) !== undefined
          ? { approvedScopes: asStringArray(body.approvedScopes)!.filter(isOmniaScope) }
          : {}),
        ...(typeof body.approvalFingerprint === "string" ? { approvalFingerprint: body.approvalFingerprint } : {}),
        ...(requestSessionId(request, body) === undefined ? {} : { sessionId: requestSessionId(request, body) }),
        ...(operator ? {} : { origin: "agent" as const }),
      })
      json(response, outcome.httpStatus, { ok: outcome.result.success, result: outcome.result })
      return true
    }

    if (parsed.method === "POST" && segments.length === 4 && action === "do") {
      const body = (await readBoundBody(context, request)) as Record<string, unknown> | undefined
      if (!isRecord(body) || !Array.isArray(body.steps)) {
        json(response, 400, { ok: false, error: "A steps array is required." })
        return true
      }
      const mayApprove = presentsServerToken(context, request)
      const operator = isOperatorRequest(context, request, body)
      const parsedSteps = body.steps.map((step): ServerBatchStep | undefined =>
        isRecord(step) ? parseBatchStep(step, mayApprove) : undefined,
      )
      if (parsedSteps.some((step) => step === undefined)) {
        json(response, 400, { ok: false, error: "Every batch step must be an object with a string action." })
        return true
      }
      const resumeFrom =
        typeof body.resumeFrom === "number" && Number.isFinite(body.resumeFrom) && body.resumeFrom > 0
          ? Math.min(Math.floor(body.resumeFrom), body.steps.length)
          : 0
      let batchCancelled = false
      response.on("close", () => {
        if (!response.writableEnded) batchCancelled = true
      })
      const outcome = await context.computers.executeBatch(computerId, {
        steps: parsedSteps as ServerBatchStep[],
        resumeFrom,
        shouldStop: () => batchCancelled,
        ...(typeof body.stopOnError === "boolean" ? { stopOnError: body.stopOnError } : {}),
        ...(mayApprove && body.approve === true ? { approve: true } : {}),
        ...(typeof body.approvedBy === "string" ? { approvedBy: body.approvedBy } : {}),
        ...(mayApprove && asStringArray(body.approvedScopes) !== undefined
          ? { approvedScopes: asStringArray(body.approvedScopes)!.filter(isOmniaScope) }
          : {}),
        ...(typeof body.approvalFingerprint === "string" ? { approvalFingerprint: body.approvalFingerprint } : {}),
        ...(requestSessionId(request, body) === undefined ? {} : { sessionId: requestSessionId(request, body) }),
        ...(operator ? {} : { origin: "agent" as const }),
      })
      json(response, outcome.httpStatus, { ok: outcome.result.success, result: outcome.result })
      return true
    }
    if (parsed.method === "POST" && segments.length === 4 && (action === "connect" || action === "disconnect")) {
      const raw = await readBoundBody(context, request)
      const body = isRecord(raw) ? raw : {}
      const denied = gateAgentAction(context, request, body, action, computerId, ["PROCESS_EXECUTE"])
      if (denied !== undefined) {
        json(response, denied.status, { ok: false, result: denied.result })
        return true
      }
      const outcome = action === "connect"
        ? await context.computers.connect(computerId)
        : await context.computers.disconnect(computerId)
      json(response, outcome.httpStatus, { ok: outcome.result.success, result: outcome.result })
      return true
    }
    if (parsed.method === "POST" && segments.length === 4 && action === "stop") {
      const body = (await readBoundBody(context, request)) as Record<string, unknown> | undefined
      const outcome = await context.computers.stop(computerId, {
        ...(isRecord(body) && typeof body.reason === "string" ? { reason: body.reason } : {}),
        ...(isRecord(body) && typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
      })
      json(response, outcome.httpStatus, { ok: outcome.result.success, result: outcome.result })
      return true
    }
    if (action === "credentials") {
      if (parsed.method === "GET" && segments.length === 4) {
        const denied = gateAgentAction(context, request, {}, "credentials", computerId, ["SECRETS"])
        if (denied !== undefined) {
          json(response, denied.status, { ok: false, result: denied.result })
          return true
        }
        json(response, 200, { ok: true, credentials: context.credentials.summaries(computerId) })
        return true
      }
      if (parsed.method === "POST" && segments.length === 4) {
        const body = (await readBoundBody(context, request)) as Record<string, unknown> | undefined
        if (!isRecord(body) || typeof body.name !== "string" || body.name.trim().length === 0) {
          json(response, 400, { ok: false, error: "A credential name is required." })
          return true
        }
        const denied = gateAgentAction(context, request, body, "credentials", computerId, ["SECRETS"])
        if (denied !== undefined) {
          json(response, denied.status, { ok: false, result: denied.result })
          return true
        }
        const rules = Array.isArray(body.rules)
          ? body.rules.flatMap((rule) =>
              isRecord(rule) && isCredentialRuleKind(rule.kind) && typeof rule.match === "string"
                ? [{ kind: rule.kind, match: rule.match }]
                : [],
            )
          : []
        const existing = typeof body.id === "string" ? context.credentials.get(body.id) : undefined
        if (existing !== undefined && existing.computerId !== computerId && existing.computerId !== "*") {
          json(response, 403, { ok: false, error: `Credential ${existing.id} is not stored for ${computerId}.` })
          return true
        }
        const saved = context.credentials.save({
          ...(typeof body.id === "string" ? { id: body.id } : {}),
          // The route owns the computer scope; a body computerId must never
          // widen a credential to "*" or another computer.
          computerId,
          name: body.name,
          ...(isCredentialKind(body.kind) ? { kind: body.kind } : {}),
          ...(typeof body.username === "string" ? { username: body.username } : {}),
          ...(typeof body.secret === "string" ? { secret: body.secret } : {}),
          rules,
          ...(typeof body.description === "string" ? { description: body.description } : {}),
          ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
        })
        context.events.emit(existing === undefined ? "credential.created" : "credential.updated", {
          computerId,
          data: { id: saved.id, name: saved.name },
        })
        json(response, 200, { ok: true, credential: summarizeCredential(saved) })
        return true
      }
      if (parsed.method === "DELETE" && segments.length === 5) {
        const credentialId = segments[4]!
        const denied = gateAgentAction(context, request, {}, "credentials", computerId, ["SECRETS"])
        if (denied !== undefined) {
          json(response, denied.status, { ok: false, result: denied.result })
          return true
        }
        const existing = context.credentials.get(credentialId)
        if (existing !== undefined && existing.computerId !== computerId && existing.computerId !== "*") {
          json(response, 403, { ok: false, error: `Credential ${credentialId} is not stored for ${computerId}.` })
          return true
        }
        const removed = context.credentials.remove(credentialId)
        if (removed) {
          context.events.emit("credential.removed", { computerId, data: { id: credentialId } })
        }
        json(response, removed ? 200 : 404, {
          ok: removed,
          ...(removed ? {} : { error: `No credential ${credentialId} is stored for ${computerId}.` }),
        })
        return true
      }
    }
    json(response, 404, { ok: false, error: "Unknown computer route." })
    return true
  }

  if (parsed.method === "GET" && segments.length === 3 && segments[1] === "computers") {
    const summary = await context.computers.summary(segments[2]!)
    if (!summary) {
      json(response, 404, { ok: false, error: `Unknown computer ${segments[2]}.` })
      return true
    }
    json(response, 200, { ok: true, computer: summary })
    return true
  }

  if (segments.length >= 2 && segments[1] === "memories") {
    if (parsed.method === "GET" && segments.length === 3 && segments[2] === "stats") {
      json(response, 200, { ok: true, stats: context.memoryStats() })
      return true
    }
    if (parsed.method === "GET" && segments.length === 2) {
      const denied = gateAgentAction(context, request, {}, "memories_read", "memories", ["FILES_READ"])
      if (denied !== undefined) {
        json(response, denied.status, { ok: false, result: denied.result })
        return true
      }
      const query = parsed.url.searchParams.get("query") ?? undefined
      const scope = parsed.url.searchParams.get("scope") ?? undefined
      const application = parsed.url.searchParams.get("application") ?? undefined
      const key = parsed.url.searchParams.get("key") ?? undefined
      const limit = Number(parsed.url.searchParams.get("limit") ?? "50")
      const includeExpired = parsed.url.searchParams.get("includeExpired") === "true"
      const tags = (parsed.url.searchParams.get("tags") ?? "")
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0)
      const records = context.memories({
        ...(query === undefined || query.length === 0 ? {} : { query }),
        ...(scope === undefined || scope.length === 0 ? {} : { scope: scope as MemoryQuery["scope"] }),
        ...(application === undefined ? {} : { application }),
        ...(key === undefined ? {} : { key }),
        ...(tags.length === 0 ? {} : { tags }),
        limit: Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), 200)) : 50,
        includeExpired,
      })
      json(response, 200, { ok: true, memories: records, total: records.length })
      return true
    }
    if (parsed.method === "POST" && segments.length === 3 && segments[2] === "forget") {
      const body = (await readBoundBody(context, request)) as Record<string, unknown> | undefined
      if (!isRecord(body)) {
        json(response, 400, { ok: false, error: "A JSON body is required." })
        return true
      }
      const denied = memoryPermission(context, request, body, "FILES_WRITE")
      if (denied !== undefined) {
        json(response, denied.status, { ok: false, result: denied.result })
        return true
      }
      const removed = context.forgetMemories({
        ...(typeof body.query === "string" ? { query: body.query } : {}),
        ...(typeof body.key === "string" ? { key: body.key } : {}),
        ...(isMemoryScope(body.scope) ? { scope: body.scope } : {}),
        ...(typeof body.application === "string" ? { application: body.application } : {}),
        limit: 100,
      })
      json(response, 200, { ok: true, removed })
      return true
    }
    if (parsed.method === "POST" && segments.length === 2) {
      const body = (await readBoundBody(context, request)) as Record<string, unknown> | undefined
      if (!isRecord(body) || typeof body.text !== "string" || !isMemoryScope(body.scope)) {
        json(response, 400, { ok: false, error: "A valid scope and text are required." })
        return true
      }
      const denied = memoryPermission(context, request, body, "FILES_WRITE")
      if (denied !== undefined) {
        json(response, denied.status, { ok: false, result: denied.result })
        return true
      }
      try {
        const record = context.writeMemory({
          scope: body.scope,
          text: body.text,
          ...(typeof body.key === "string" ? { key: body.key } : {}),
          ...(asStringArray(body.tags) === undefined ? {} : { tags: asStringArray(body.tags)! }),
          ...(typeof body.application === "string" ? { application: body.application } : {}),
          ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
          ...(typeof body.workspace === "string" ? { workspace: body.workspace } : {}),
          ...(body.source === "agent" || body.source === "system" || body.source === "user" ? { source: body.source } : {}),
          ...(typeof body.confidence === "number" ? { confidence: body.confidence } : {}),
          ...(body.sensitivity === "public" || body.sensitivity === "internal" || body.sensitivity === "private"
            ? { sensitivity: body.sensitivity }
            : {}),
          ...(typeof body.expiresInDays === "number" ? { expiresInDays: body.expiresInDays } : {}),
        })
        json(response, 200, { ok: true, memory: { ...record } })
      } catch (error) {
        json(response, 400, { ok: false, error: error instanceof Error ? error.message : "Invalid memory." })
      }
      return true
    }
    const id = segments[2]
    if (id !== undefined && parsed.method === "DELETE" && segments.length === 3) {
      const deleteBody = (await readBoundBody(context, request)) as Record<string, unknown> | undefined
      const denied = memoryPermission(context, request, isRecord(deleteBody) ? deleteBody : {}, "FILES_WRITE")
      if (denied !== undefined) {
        json(response, denied.status, { ok: false, result: denied.result })
        return true
      }
      json(response, 200, { ok: true, removed: context.removeMemory(id) })
      return true
    }
    json(response, 404, { ok: false, error: "Unknown memory route." })
    return true
  }

  if (segments.length >= 2 && segments[1] === "superskills") {
    if (parsed.method === "GET" && segments.length === 2) {
      json(response, 200, { ok: true, superskills: context.superskills() })
      return true
    }
    if (parsed.method === "POST" && segments.length === 2) {
      const body = await readBoundBody(context, request)
      const record = isRecord(body) ? body : {}
      const denied = gateAgentAction(
        context,
        request,
        record,
        "superskill_save",
        typeof record.id === "string" && record.id.length > 0 ? record.id : "superskill",
        superskillScopes(isRecord(record.bridge) ? record.bridge.type : undefined),
      )
      if (denied !== undefined) {
        json(response, denied.status, { ok: false, result: denied.result })
        return true
      }
      try {
        const skill = context.saveSuperskill(body)
        json(response, 200, { ok: true, superskill: redactSuperskill(skill) })
      } catch (error) {
        json(response, 400, { ok: false, error: error instanceof Error ? error.message : "Invalid superskill." })
      }
      return true
    }
    const id = segments[2]
    if (id !== undefined && parsed.method === "GET" && segments.length === 3) {
      const skill = context.superskill(id)
      if (skill === undefined) {
        json(response, 404, { ok: false, error: `Unknown superskill ${id}.` })
        return true
      }
      json(response, 200, { ok: true, superskill: redactSuperskill(skill) })
      return true
    }
    if (id !== undefined && parsed.method === "DELETE" && segments.length === 3) {
      const denied = gateAgentAction(context, request, {}, "superskill_delete", id, ["PROCESS_EXECUTE"])
      if (denied !== undefined) {
        json(response, denied.status, { ok: false, result: denied.result })
        return true
      }
      json(response, 200, { ok: true, removed: context.removeSuperskill(id) })
      return true
    }
    if (id !== undefined && parsed.method === "POST" && segments.length === 4 && segments[3] === "call") {
      const body = (await readBoundBody(context, request)) as Record<string, unknown> | undefined
      if (!isRecord(body) || typeof body.method !== "string" || body.method.length === 0) {
        json(response, 400, { ok: false, error: "A method is required." })
        return true
      }
      const skill = context.superskill(id)
      if (skill === undefined) {
        json(response, 404, { ok: false, error: `Unknown superskill ${id}.` })
        return true
      }
      const method = skill.methods.find((entry) => entry.name === body.method)
      if (method === undefined) {
        json(response, 400, {
          ok: false,
          error: `Superskill ${id} has no method ${body.method}.`,
          methods: skill.methods.map((entry) => entry.name),
        })
        return true
      }
      const required =
        method.scopes !== undefined && method.scopes.length > 0
          ? method.scopes
          : skill.scopes !== undefined && skill.scopes.length > 0
            ? skill.scopes
            : superskillScopes(skill.bridge.type)
      const operation: OperationInput = { action: `superskill:${id}:${body.method}`, resources: [id] }
      const decision = context.permissions.evaluate(required, {
        sessionId: requestSessionId(request, body),
        approval: approvalFromBody(context, request, body),
        operation,
      })
      if (!decision.allowed) {
        json(response, decision.status === "denied" ? 403 : 428, {
          ok: false,
          result: {
            success: false,
            status: "rejected",
            message: decision.reason ?? "Permission required.",
            error: {
              code: decision.status === "denied" ? "permission_denied" : "permission_required",
              message: decision.reason ?? "Permission required.",
              retryable: decision.status !== "denied",
              details: { missing: decision.missing, fingerprint: operationFingerprint(operation) },
            },
          },
        })
        return true
      }
      context.events.emit("superskill.called", {
        ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
        data: { superskill: id, method: body.method },
      })
      try {
        const result = await context.callSuperskill(id, body.method, body.params)
        json(response, 200, { ok: true, result })
      } catch (error) {
        json(response, 500, {
          ok: false,
          error: error instanceof Error ? error.message : "The superskill call failed.",
        })
      }
      return true
    }
    json(response, 404, { ok: false, error: "Unknown superskill route." })
    return true
  }

  if (parsed.method === "GET" && segments.length === 2 && segments[1] === "permissions") {
    json(response, 200, {
      ok: true,
      approvalPolicy: context.permissions.approvalPolicy,
      scopes: describePermissions(context.permissions.snapshot()),
    })
    return true
  }

  if (segments.length === 3 && segments[1] === "permissions" && segments[2] === "approve") {
    if (parsed.method !== "POST") {
      json(response, 404, { ok: false, error: "Unknown permissions route." })
      return true
    }
    const body = (await readBoundBody(context, request)) as Record<string, unknown> | undefined
    if (!isRecord(body) || !operatorOnly(context, request, body)) {
      json(response, 403, { ok: false, error: "Only the desktop operator can grant approvals." })
      return true
    }
    if (typeof body.action !== "string" || body.action.length === 0) {
      json(response, 400, { ok: false, error: "An action is required." })
      return true
    }
    const resources = asStringArray(body.resources)?.filter((entry) => entry.length > 0)
    if (resources === undefined || resources.length === 0) {
      json(response, 400, { ok: false, error: "Approval resources are required." })
      return true
    }
    const operation: OperationInput = {
      action: body.action,
      resources,
      ...(typeof body.command === "string" ? { command: body.command } : {}),
    }
    try {
      const grant = context.approvals.issue(operation, "operator", {
        ...(finiteNumber(body.expiresInMs, { min: 1, max: 3_600_000 }) === undefined
          ? {}
          : { expiresInMs: finiteNumber(body.expiresInMs, { min: 1, max: 3_600_000 })! }),
        ...(finiteNumber(body.maxUses, { min: 1, max: 100 }) === undefined
          ? {}
          : { maxUses: Math.floor(finiteNumber(body.maxUses, { min: 1, max: 100 })!) }),
      })
      json(response, 200, {
        ok: true,
        approval: {
          id: grant.id,
          fingerprint: operationFingerprint(operation),
          ...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }),
          ...(grant.usesRemaining === undefined ? {} : { usesRemaining: grant.usesRemaining }),
        },
      })
    } catch (error) {
      json(response, 400, { ok: false, error: error instanceof Error ? error.message : "The approval could not be issued." })
    }
    return true
  }

  if (parsed.method === "POST" && segments.length === 2 && segments[1] === "permissions") {
    const body = (await readBoundBody(context, request)) as Record<string, unknown> | undefined
    if (!operatorOnly(context, request, isRecord(body) ? body : {})) {
      json(response, 403, { ok: false, error: "Only the desktop operator can change permission scopes." })
      return true
    }
    if (!isRecord(body) || typeof body.scope !== "string" || !isOmniaScope(body.scope)) {
      json(response, 400, { ok: false, error: "A valid permission scope is required." })
      return true
    }
    const state = body.state
    if (typeof state !== "string" || !(PERMISSION_STATES as readonly string[]).includes(state)) {
      json(response, 400, { ok: false, error: "A valid permission state is required." })
      return true
    }
    context.permissions.set(body.scope, state as PermissionState)
    json(response, 200, { ok: true, scopes: describePermissions(context.permissions.snapshot()) })
    return true
  }

  if (parsed.method === "GET" && segments.length === 2 && segments[1] === "events") {
    const stream = context.subscribe(response)
    return stream !== undefined
  }

  if (segments.length === 3 && segments[1] === "input") {
    if (parsed.method === "GET" && segments[2] === "state") {
      const state = await context.computers.inputState(parsed.url.searchParams.get("computerId") ?? undefined)
      json(response, 200, {
        ok: true,
        frozen: state.frozen,
        supported: state.supported,
        ...(state.reason === undefined ? {} : { reason: state.reason }),
        ...(state.releasedBy === undefined ? {} : { releasedBy: state.releasedBy }),
      })
      return true
    }
    if (parsed.method === "POST" && (segments[2] === "freeze" || segments[2] === "release")) {
      const raw = await readBoundBody(context, request)
      const body = isRecord(raw) ? raw : {}
      // Plan before permission: there is no point asking an operator to approve a
      // freeze that billing is about to refuse.
      //
      // Release is deliberately NOT gated. It is the way out of a grab this gate
      // may have allowed, so making the escape hatch conditional on money would
      // leave a customer's input disabled until somebody upgraded - refusing the
      // way out is strictly worse than never allowing the way in.
      if (segments[2] === "freeze") {
        const unbilled = await capabilityDenied(context, "input_freeze")
        if (unbilled !== undefined) {
          json(response, unbilled.status, unbilled.payload)
          return true
        }
      }
      const denied = inputControlPermission(context, request, body)
      if (denied !== undefined) {
        json(response, denied.status, { ok: false, error: denied.error })
        return true
      }
      const computerId = typeof body.computerId === "string" ? body.computerId : undefined
      if (computerId === undefined) {
        json(response, 400, { ok: false, error: "Freezing or releasing input needs an explicit computerId." })
        return true
      }
      if (segments[2] === "freeze") {
        const reason = typeof body.reason === "string" ? body.reason : undefined
        const outcome = await context.computers.freezeInput(computerId, reason)
        if (outcome.frozen) {
          json(response, 200, { ok: true, frozen: true, mode: outcome.mode ?? "x11" })
          return true
        }
        json(response, 501, {
          ok: false,
          error: outcome.error ?? "Freezing physical input is not available on this computer.",
          supported: outcome.supported,
        })
        return true
      }
      const outcome = await context.computers.releaseInput(computerId)
      if (outcome.error !== undefined) {
        json(response, 500, { ok: false, error: outcome.error, supported: outcome.supported })
        return true
      }
      json(response, 200, { ok: true, frozen: false, releasedBy: outcome.releasedBy })
      return true
    }
    json(response, 404, { ok: false, error: "Unknown input route." })
    return true
  }

  if (parsed.method === "GET" && segments.length === 2 && segments[1] === "sessions") {
    json(response, 200, { ok: true, sessions: context.sessions() })
    return true
  }

  if (parsed.method === "GET" && segments.length === 2 && [ "agents", "skills", "models" ].includes(segments[1]!)) {
    const catalog = context.catalog()
    const key = segments[1] as "agents" | "skills" | "models"
    json(response, 200, {
      ok: true,
      [key]: catalog[key],
      ...(key === "models" ? { note: "Models are registered by the connected agent runtime; capabilities describe tool calling, vision, and context." } : {}),
    })
    return true
  }

  if (parsed.method === "POST" && segments.length === 2 && segments[1] === "models") {
    const body = (await readBoundBody(context, request)) as Record<string, unknown> | undefined
    if (!isRecord(body) || !Array.isArray(body.models)) {
      json(response, 400, { ok: false, error: "A models array is required." })
      return true
    }
    const models = body.models.flatMap((entry): ServerCatalogEntry[] => {
      if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) return []
      const capabilities = isRecord(entry.capabilities)
        ? Object.fromEntries(
            Object.entries(entry.capabilities).filter(
              (pair): pair is [string, boolean | number] =>
                typeof pair[1] === "boolean" || typeof pair[1] === "number",
            ),
          )
        : undefined
      return [
        {
          id: entry.id,
          ...(typeof entry.name === "string" ? { name: entry.name } : {}),
          ...(typeof entry.description === "string" ? { description: entry.description } : {}),
          ...(typeof entry.provider === "string" ? { provider: entry.provider } : {}),
          ...(capabilities === undefined ? {} : { capabilities }),
        },
      ]
    })
    context.registerModels(models)
    json(response, 200, { ok: true, models: context.catalog().models })
    return true
  }

  if (segments.length >= 2 && segments[1] === "computer-use") {
    if (parsed.method === "GET" && segments.length === 3 && segments[2] === "models") {
      json(response, 200, { ok: true, models: await context.computerUse.models() })
      return true
    }
    if (parsed.method === "GET" && segments.length === 3 && segments[2] === "runtimes") {
      json(response, 200, { ok: true, runtimes: context.computerUse.runtimes() })
      return true
    }
    if (parsed.method === "GET" && segments.length === 3 && segments[2] === "providers") {
      json(response, 200, { ok: true, providers: await context.computerUse.providers() })
      return true
    }
    if (parsed.method === "GET" && segments.length === 3 && segments[2] === "status") {
      json(response, 200, { ok: true, status: await context.computerUse.status() })
      return true
    }
    if (parsed.method === "GET" && segments.length === 3 && segments[2] === "settings") {
      json(response, 200, { ok: true, settings: context.computerUse.settings() })
      return true
    }
    if (parsed.method === "GET" && segments.length === 3 && segments[2] === "diagnostics") {
      json(response, 200, { ok: true, diagnostics: context.computerUse.diagnostics() })
      return true
    }
    if (parsed.method === "GET" && segments.length === 3 && segments[2] === "calibration") {
      const computer = context.computers.get(context.computers.ids()[0] ?? "")
      const info = await computer?.driver.getInfo().catch(() => undefined)
      const screen = (info as { screen?: { width: number; height: number } } | undefined)?.screen
      json(response, 200, { ok: true, calibration: context.calibration.status(screen) })
      return true
    }
    if (parsed.method === "DELETE" && segments.length === 3 && segments[2] === "calibration") {
      const denied = gateAgentAction(context, request, {}, "calibration_reset", "calibration", ["UI_CONTROL"])
      if (denied !== undefined) {
        json(response, denied.status, { ok: false, result: denied.result })
        return true
      }
      context.calibration.reset()
      json(response, 200, { ok: true })
      return true
    }
    if (parsed.method === "POST" && segments.length === 4 && segments[2] === "calibration") {
      const body = (await readBoundBody(context, request)) as Record<string, unknown> | undefined
      if (!isRecord(body)) {
        json(response, 400, { ok: false, error: "A JSON body is required." })
        return true
      }
      const computerId = typeof body.computerId === "string" ? body.computerId : context.computers.ids()[0]
      const computer = computerId === undefined ? undefined : context.computers.get(computerId)
      if (computer === undefined) {
        json(response, 404, { ok: false, error: "Unknown computer." })
        return true
      }
      const info = await computer.driver.getInfo().catch(() => undefined)
      const screen = (info as { screen?: { width: number; height: number } } | undefined)?.screen ?? {
        width: 1920,
        height: 1080,
      }
      if (segments[3] === "start") {
        json(response, 200, { ok: true, screen, points: context.calibration.grid(screen) })
        return true
      }
      if (segments[3] === "measure") {
        const pointId = typeof body.pointId === "string" ? body.pointId : undefined
        const point = context.calibration.grid(screen).find((entry) => entry.id === pointId)
        if (point === undefined) {
          json(response, 400, { ok: false, error: "Unknown calibration point." })
          return true
        }
        json(response, 200, { ok: true, measurement: await context.calibration.measure(computer.driver, point) })
        return true
      }
      if (segments[3] === "save") {
        const denied = gateAgentAction(context, request, body, "calibration_save", computerId ?? "calibration", ["UI_CONTROL"])
        if (denied !== undefined) {
          json(response, denied.status, { ok: false, result: denied.result })
          return true
        }
        const profile = context.calibration.computeProfile(calibrationMeasurements(body.measurements), screen)
        if (profile === undefined) {
          json(response, 400, { ok: false, error: "No valid measurements to calibrate from." })
          return true
        }
        const saved = context.calibration.save(clampCalibrationProfile(profile))
        json(response, 200, { ok: true, profile: saved })
        return true
      }
    }
    if (parsed.method === "POST" && segments.length === 3 && segments[2] === "settings") {
      const body = await readBoundBody(context, request)
      json(response, 200, { ok: true, settings: context.computerUse.updateSettings(body) })
      return true
    }
    if (parsed.method === "POST" && segments.length === 3 && segments[2] === "route") {
      const body = (await readBoundBody(context, request)) as Record<string, unknown> | undefined
      if (!isRecord(body)) {
        json(response, 400, { ok: false, error: "A JSON body is required." })
        return true
      }
      const decision = await context.computerUse.route(computerUseContext(body))
      json(response, 200, { ok: true, decision })
      return true
    }
    if (parsed.method === "POST" && segments.length === 3 && segments[2] === "analyze") {
      const body = (await readBoundBody(context, request)) as Record<string, unknown> | undefined
      if (!isRecord(body)) {
        json(response, 400, { ok: false, error: "A JSON body is required." })
        return true
      }
      // The analyze step captures the screen and reads the accessibility tree,
      // so an agent-originated request needs SCREEN_READ approval. Desktop
      // calls carry no sessionId and the UI itself is the approver.
      const analyzeComputerId = typeof body.computerId === "string" ? body.computerId : context.computers.ids()[0] ?? "local"
      const denied = gateAgentAction(context, request, body, "computer-use.analyze", analyzeComputerId, ["SCREEN_READ"])
      if (denied !== undefined) {
        json(response, denied.status, {
          ok: false,
          error: denied.result.error,
        })
        return true
      }
      const sessionId = requestSessionId(request, body)
      const mayApprove = presentsServerToken(context, request)
      const input = {
        computerId: analyzeComputerId,
        operation: computerUseOperation(body.requestedOperation),
        ...(typeof body.targetDescription === "string" ? { targetDescription: body.targetDescription } : {}),
        ...(typeof body.taskContext === "string" ? { taskContext: body.taskContext } : {}),
        ...(typeof body.question === "string" ? { question: body.question } : {}),
        ...(typeof body.text === "string" ? { text: body.text } : {}),
        ...(finiteNumber(body.timeoutMs, { min: 0, max: 600_000 }) === undefined
          ? {}
          : { timeoutMs: finiteNumber(body.timeoutMs, { min: 0, max: 600_000 })! }),
        ...(sessionId === undefined ? {} : { sessionId }),
        // Only the operator's own approval claim counts; a client token keeps
        // its fingerprint proof but cannot approve the action for itself.
        ...(mayApprove && body.approve === true ? { approve: true } : {}),
        ...(typeof body.approvedBy === "string" ? { approvedBy: body.approvedBy } : {}),
        ...(mayApprove && asStringArray(body.approvedScopes) !== undefined
          ? { approvedScopes: asStringArray(body.approvedScopes)!.filter(isOmniaScope) }
          : {}),
        // Executing is opt-in: analyze inspects by default and only acts when
        // the caller explicitly asks for it.
        execute: body.execute === true,
      }
      const outcome = await context.computerUse.perform(input)
      json(response, 200, {
        ok: outcome.analysis.result.success,
        ...outcome,
        decision: outcome.analysis.decision,
        result: outcome.analysis.result,
        fallbacks: outcome.analysis.fallbacks,
        ...(outcome.analysis.errorCode === undefined ? {} : { errorCode: outcome.analysis.errorCode }),
        ...(outcome.analysis.result.success
          ? {}
          : { error: outcome.analysis.result.reasoning ?? "Computer-use analysis failed." }),
      })
      return true
    }
    if (segments.length === 5 && segments[2] === "runtimes" && parsed.method === "POST") {
      const id = segments[3]!
      const action = segments[4]!
      const denied = operatorDenied(context, request)
      if (denied !== undefined) {
        json(response, denied.status, denied.payload)
        return true
      }
      if (action === "download") {
        const settings = context.computerUse.settings()
        if (!settings.allowDownloads) {
          json(response, 400, { ok: false, error: "Model downloads are disabled in computer-use settings." })
          return true
        }
        if (!context.computerUse.runtimes().some((entry) => entry.runtime.id === id)) {
          json(response, 404, { ok: false, error: `Unknown computer-use runtime ${id}.` })
          return true
        }
        void context.computerUse.downloadRuntime(id).catch(() => undefined)
        json(response, 200, { ok: true, started: true })
        return true
      }
      json(response, 404, { ok: false, error: `Unknown runtime action ${action}.` })
      return true
    }
    if (segments.length === 4 && segments[2] === "runtimes" && parsed.method === "DELETE") {
      const denied = operatorDenied(context, request)
      if (denied !== undefined) {
        json(response, denied.status, denied.payload)
        return true
      }
      json(response, 200, { ok: true, removed: await context.computerUse.removeRuntime(segments[3]!) })
      return true
    }
    if (segments.length === 5 && segments[2] === "models" && parsed.method === "POST") {
      const id = segments[3]!
      const action = segments[4]!
      if (action === "download") {
        const denied = operatorDenied(context, request)
        if (denied !== undefined) {
          json(response, denied.status, denied.payload)
          return true
        }
      }
      if (action === "load") {
        try {
          json(response, 200, { ok: true, model: await context.computerUse.loadModel(id) })
        } catch (error) {
          json(response, 400, { ok: false, error: error instanceof Error ? error.message : "Load failed." })
        }
        return true
      }
      if (action === "unload") {
        json(response, 200, { ok: true, unloaded: await context.computerUse.unloadModel(id) })
        return true
      }
      if (action === "download") {
        const settings = context.computerUse.settings()
        if (!settings.allowDownloads) {
          json(response, 400, { ok: false, error: "Model downloads are disabled in computer-use settings." })
          return true
        }
        if (!(await context.computerUse.models()).some((entry) => entry.model.id === id)) {
          json(response, 404, { ok: false, error: `Unknown computer-use model ${id}.` })
          return true
        }
        // Downloads are large and long-running; start them in the background
        // and let the client follow progress through the models list.
        void context.computerUse.downloadModel(id).catch(() => undefined)
        json(response, 200, { ok: true, started: true })
        return true
      }
      json(response, 404, { ok: false, error: `Unknown model action ${action}.` })
      return true
    }
    if (segments.length === 4 && segments[2] === "models" && parsed.method === "DELETE") {
      const denied = operatorDenied(context, request)
      if (denied !== undefined) {
        json(response, denied.status, denied.payload)
        return true
      }
      json(response, 200, { ok: true, removed: await context.computerUse.removeModel(segments[3]!) })
      return true
    }
    json(response, 404, { ok: false, error: "Unknown computer-use route." })
    return true
  }

  // Billing lives in its own module because it is the money path. It is matched
  // before anything that parses a body, because the Stripe webhook must verify
  // its signature over the RAW bytes.
  if (segments[1] === "billing") {
    if (await handleBillingRoute(context, request, response, parsed)) return true
  }

  if (segments.length === 3 && segments[1] === "auth" && segments[2] === "clients" && parsed.method === "POST") {
    // Operator-only provisioning: mint a durable client token for the signed-in
    // profile so admin-provisioned thin clients can register runtimes. The
    // server token is the only operator credential; a client token never mints
    // another client token.
    if (!presentsServerToken(context, request)) {
      json(response, 401, { ok: false, error: "operator_token_required" })
      return true
    }
    const token = context.auth.mintClientToken()
    if (token === undefined) {
      json(response, 409, { ok: false, error: "Sign in to GitHub on the control plane before minting client tokens." })
      return true
    }
    json(response, 200, { ok: true, clientToken: token, status: context.auth.status() })
    return true
  }

  if (segments.length >= 3 && segments[1] === "auth" && segments[2] === "github") {
    if (parsed.method === "GET" && segments.length === 4 && segments[3] === "status") {
      json(response, 200, { ok: true, status: context.auth.status() })
      return true
    }
    if (parsed.method === "GET" && segments.length === 4 && segments[3] === "callback") {
      const error = parsed.url.searchParams.get("error")
      const code = parsed.url.searchParams.get("code") ?? ""
      const state = parsed.url.searchParams.get("state") ?? ""
      if (error !== null) {
        html(
          response,
          400,
          renderGitHubCallbackPage("Sign-in cancelled", "GitHub did not authorize the sign-in. You can close this tab."),
        )
        return true
      }
      if (code.length === 0 || state.length === 0) {
        html(
          response,
          400,
          renderGitHubCallbackPage(
            "Sign-in rejected",
            "The callback did not include an authorization code and state. Close this tab and start again from Omnia.",
          ),
        )
        return true
      }
      const callback = await context.auth.completeCallback(state, code)
      if (callback.ok) {
        html(
          response,
          200,
          renderGitHubCallbackPage("Signed in", "Omnia is now connected to GitHub. You can close this tab."),
        )
        return true
      }
      html(response, callback.status, renderGitHubCallbackPage(callback.title, callback.message))
      return true
    }
    if (parsed.method === "POST" && segments.length === 4 && segments[3] === "poll") {
      const body = (await readBody(request)) as Record<string, unknown> | undefined
      const state = isRecord(body) && typeof body.state === "string" ? body.state : ""
      if (state.length === 0) {
        json(response, 400, { ok: false, error: "A pending sign-in state is required." })
        return true
      }
      const polled = context.auth.poll(state)
      if (polled === undefined) {
        json(response, 400, { ok: false, error: "unknown_state" })
        return true
      }
      json(response, 200, { ok: true, ...polled })
      return true
    }
    if (parsed.method === "POST" && segments.length === 4 && segments[3] === "start") {
      const body = (await readBoundBody(context, request)) as Record<string, unknown> | undefined
      const method = isRecord(body) && typeof body.method === "string" ? body.method : "browser"
      if (method !== "browser") {
        json(response, 400, {
          ok: false,
          error: `GitHub sign-in method "${method}" is not supported; use the public browser callback.`,
        })
        return true
      }
      try {
        const result = await context.auth.start("browser")
        json(response, 200, { ok: true, ...result })
      } catch (error) {
        json(response, 400, { ok: false, error: error instanceof Error ? error.message : "GitHub sign-in failed." })
      }
      return true
    }
    if (parsed.method === "POST" && segments.length === 4 && segments[3] === "client") {
      const body = (await readBoundBody(context, request)) as Record<string, unknown> | undefined
      if (!isRecord(body) || typeof body.clientId !== "string") {
        json(response, 400, { ok: false, error: "A clientId is required." })
        return true
      }
      const denied = operatorDenied(context, request, body)
      if (denied !== undefined) {
        json(response, denied.status, denied.payload)
        return true
      }
      try {
        const status = context.auth.saveOAuthClient(
          body.clientId,
          typeof body.clientSecret === "string" ? body.clientSecret : undefined,
        )
        json(response, 200, { ok: true, status })
      } catch (error) {
        json(response, 400, { ok: false, error: error instanceof Error ? error.message : "Invalid OAuth client." })
      }
      return true
    }
    if (parsed.method === "POST" && segments.length === 4 && segments[3] === "logout") {
      const denied = operatorDenied(context, request)
      if (denied !== undefined) {
        json(response, denied.status, denied.payload)
        return true
      }
      await context.auth.logout()
      json(response, 200, { ok: true, status: context.auth.status() })
      return true
    }
    json(response, 404, { ok: false, error: "Unknown auth route." })
    return true
  }

  json(response, 404, { ok: false, error: "Unknown route." })
  return true
}

const CUA_ACTION_NAMES = [
  "invoke",
  "set_value",
  "focus",
  "scroll_into_view",
  "select",
  "expand",
  "collapse",
  "increment",
  "decrement",
  "show_menu",
  "click",
  "type",
  "key",
  "scroll",
  "drag",
  "window",
  "dismiss",
] as const

const CUA_SCOPE_ACTIONS: Readonly<Record<(typeof CUA_ACTION_NAMES)[number], string>> = {
  invoke: "click",
  set_value: "set_value",
  focus: "focus",
  scroll_into_view: "scroll",
  select: "select",
  expand: "expand",
  collapse: "collapse",
  increment: "increment",
  decrement: "decrement",
  show_menu: "menu",
  click: "click",
  type: "type",
  key: "key",
  scroll: "scroll",
  drag: "drag",
  window: "focus_window",
  dismiss: "dismiss",
}

// The Cua endpoints are token-authed by the server shell and mirror the
// /actions gate here: the same scopes, the same approval fields, and the same
// 403/428 result shape as ComputerManager.execute.
async function handleCuaRequest(
  context: ApiContext,
  request: IncomingMessage,
  response: ServerResponse,
  computerId: string,
  subroute: string,
  method: string,
): Promise<boolean> {
  if (method !== "POST") {
    json(response, 404, { ok: false, error: "Unknown cua route." })
    return true
  }
  const body = (await readBoundBody(context, request)) as Record<string, unknown> | undefined
  const record = isRecord(body) ? body : {}
  const cua = await cuaDriverFor(context.computers.get(computerId)?.driver)
  if (cua === undefined || !cua.available) {
    json(response, 501, {
      ok: false,
      error: { code: "cua_unavailable", message: "The Cua accessibility engine is not available on this computer." },
    })
    return true
  }
  if (subroute === "snapshot") {
    if (cua.snapshot === undefined) return cuaUnavailable(response)
    const required: OmniaScope[] = record.includeScreenshot === true ? ["UI_READ", "SCREEN_READ"] : ["UI_READ"]
    const denied = cuaPermission(context, request, computerId, "snapshot", record, required)
    if (denied !== undefined) {
      json(response, denied.status, { ok: false, result: denied.result })
      return true
    }
    const snapshot = await cua.snapshot({
      ...(typeof record.app === "string" ? { app: record.app } : {}),
      ...(typeof record.maxElements === "number" ? { maxElements: record.maxElements } : {}),
      ...(record.includeScreenshot === true ? { includeScreenshot: true } : {}),
    })
    json(response, 200, { ok: true, snapshot })
    return true
  }
  if (subroute === "find") {
    if (cua.find === undefined) return cuaUnavailable(response)
    const query: CuaFindQuery = {
      ...(typeof record.name === "string" ? { name: record.name } : typeof record.query === "string" ? { name: record.query } : {}),
      ...(typeof record.role === "string" ? { role: record.role } : {}),
      ...(typeof record.text === "string" ? { text: record.text } : {}),
      ...(typeof record.window === "string" ? { window: record.window } : {}),
      ...(typeof record.limit === "number" ? { limit: record.limit } : {}),
    }
    if (Object.keys(query).length === 0) {
      json(response, 400, { ok: false, error: "Find requires a query, name, role, text, or window." })
      return true
    }
    const denied = cuaPermission(context, request, computerId, "find", record, ["UI_READ"])
    if (denied !== undefined) {
      json(response, denied.status, { ok: false, result: denied.result })
      return true
    }
    const elements = await cua.find(query)
    json(response, 200, { ok: true, elements })
    return true
  }
  if (subroute === "act") {
    if (cua.act === undefined) return cuaUnavailable(response)
    const action = cuaAction(record.action)
    if (action === undefined) {
      json(response, 400, {
        ok: false,
        error: { code: "invalid_action", message: "A valid Cua action is required." },
      })
      return true
    }
    const required = requiredScopesForAction(CUA_SCOPE_ACTIONS[action.type])
    const denied = cuaPermission(context, request, computerId, action.type, record, required)
    if (denied !== undefined) {
      json(response, denied.status, { ok: false, result: denied.result })
      return true
    }
    context.events.emit("action.started", {
      computerId,
      ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
      data: { action: action.type, engine: "cua" },
    })
    const result = await cua.act(action)
    context.events.emit(result.ok ? "action.completed" : "action.failed", {
      computerId,
      ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
      data: {
        action: action.type,
        engine: "cua",
        delivery: result.delivery,
        verified: result.verified,
        ...(result.ok ? {} : { reason: result.error?.message ?? result.message }),
      },
    })
    json(response, 200, { ok: result.ok, result })
    return true
  }
  if (subroute === "wait") {
    if (cua.wait === undefined) return cuaUnavailable(response)
    const condition = cuaWaitCondition(record.condition)
    if (condition === undefined) {
      json(response, 400, {
        ok: false,
        error: { code: "invalid_condition", message: "A wait condition with at least one field is required." },
      })
      return true
    }
    const denied = cuaPermission(context, request, computerId, "wait", record, ["UI_READ"])
    if (denied !== undefined) {
      json(response, denied.status, { ok: false, result: denied.result })
      return true
    }
    const result = await cua.wait(condition)
    json(response, 200, { ok: result.ok, result })
    return true
  }
  json(response, 404, { ok: false, error: "Unknown cua route." })
  return true
}

function cuaUnavailable(response: ServerResponse): true {
  json(response, 501, {
    ok: false,
    error: { code: "cua_unavailable", message: "The Cua accessibility engine does not support this operation." },
  })
  return true
}

function cuaPermission(
  context: ApiContext,
  request: IncomingMessage,
  computerId: string,
  action: string,
  body: Record<string, unknown>,
  required: readonly OmniaScope[],
): { status: number; result: Record<string, unknown> } | undefined {
  const sessionId = requestSessionId(request, body)
  // The Cua gate takes the same route as the /actions gate so a fingerprint
  // issued by POST /v1/permissions/approve ("cua:<action>" on this computer)
  // can actually satisfy it.
  const operation: OperationInput = { action: `cua:${action}`, resources: [computerId] }
  const decision = context.permissions.evaluate(required, {
    ...(sessionId === undefined ? {} : { sessionId }),
    approval: approvalFromBody(context, request, body),
    operation,
  })
  context.events.emit("action.requested", {
    computerId,
    ...(sessionId === undefined ? {} : { sessionId }),
    data: { action, requiredScopes: required, engine: "cua" },
  })
  if (decision.allowed) {
    if (body.approve === true) {
      context.events.emit("permission.decided", {
        computerId,
        ...(sessionId === undefined ? {} : { sessionId }),
        data: { action, approvedBy: typeof body.approvedBy === "string" ? body.approvedBy : "session", scopes: required },
      })
    }
    return undefined
  }
  context.events.emit("permission.requested", {
    computerId,
    ...(sessionId === undefined ? {} : { sessionId }),
    data: { action, missing: decision.missing, reason: decision.reason, engine: "cua" },
  })
  return {
    status: decision.status === "denied" ? 403 : 428,
    result: {
      success: false,
      status: "rejected",
      message: decision.reason ?? "Permission required.",
      error: {
        code: decision.status === "denied" ? "permission_denied" : "permission_required",
        message: decision.reason ?? "Permission required.",
        retryable: decision.status !== "denied",
        details: { missing: decision.missing, fingerprint: operationFingerprint(operation) },
      },
    },
  }
}

function cuaPoint(value: unknown): { x: number; y: number } | undefined {
  if (!isRecord(value)) return undefined
  const x = finiteNumber(value.x, { min: -1_000_000, max: 1_000_000 })
  const y = finiteNumber(value.y, { min: -1_000_000, max: 1_000_000 })
  return x === undefined || y === undefined ? undefined : { x, y }
}

function cuaAction(value: unknown): CuaAction | undefined {
  if (!isRecord(value) || typeof value.type !== "string" || !(CUA_ACTION_NAMES as readonly string[]).includes(value.type)) {
    return undefined
  }
  const ref = typeof value.ref === "string" && value.ref.length > 0 ? value.ref : undefined
  switch (value.type) {
    case "invoke":
      return ref === undefined ? undefined : { type: "invoke", ref, ...(typeof value.action === "string" ? { action: value.action } : {}) }
    case "set_value":
      return ref === undefined || typeof value.value !== "string" ? undefined : { type: "set_value", ref, value: value.value }
    case "focus":
    case "scroll_into_view":
    case "select":
    case "expand":
    case "collapse":
    case "increment":
    case "decrement":
    case "show_menu":
      return ref === undefined ? undefined : { type: value.type, ref }
    case "click": {
      const point = cuaPoint(value.point)
      if (point === undefined) return undefined
      const count = finiteNumber(value.count, { min: 1, max: 3 })
      return {
        type: "click",
        point,
        ...(value.button === "left" || value.button === "right" || value.button === "middle" ? { button: value.button } : {}),
        ...(count === undefined ? {} : { count: Math.floor(count) }),
        ...(typeof value.captureId === "string" ? { captureId: value.captureId } : {}),
      }
    }
    case "type":
      return typeof value.text === "string" ? { type: "type", text: value.text, ...(ref === undefined ? {} : { ref }) } : undefined
    case "key": {
      if (!Array.isArray(value.keys) || value.keys.length === 0 || value.keys.length > 8) return undefined
      if (!value.keys.every((key): key is string => typeof key === "string" && key.length > 0 && key.length <= 64)) return undefined
      return { type: "key", keys: value.keys }
    }
    case "scroll": {
      if (value.direction !== "up" && value.direction !== "down" && value.direction !== "left" && value.direction !== "right") {
        return undefined
      }
      return {
        type: "scroll",
        direction: value.direction,
        ...(typeof value.amount === "number" ? { amount: value.amount } : {}),
        ...(ref === undefined ? {} : { ref }),
      }
    }
    case "drag": {
      const from = cuaPoint(value.from)
      const to = cuaPoint(value.to)
      if (from === undefined || to === undefined) return undefined
      return { type: "drag", from, to, ...(typeof value.captureId === "string" ? { captureId: value.captureId } : {}) }
    }
    case "window":
      return ref !== undefined && (value.action === "focus" || value.action === "minimize" || value.action === "restore" || value.action === "close")
        ? { type: "window", action: value.action, ref }
        : undefined
    case "dismiss":
      return { type: "dismiss" }
    default:
      return undefined
  }
}

function cuaWaitCondition(value: unknown): CuaWaitCondition | undefined {
  if (!isRecord(value)) return undefined
  const timeoutMs = finiteNumber(value.timeoutMs, { min: 1, max: 600_000 })
  const pollMs = finiteNumber(value.pollMs, { min: 50, max: 5000 })
  const condition: CuaWaitCondition = {
    ...(typeof value.ref === "string" ? { ref: value.ref } : {}),
    ...(typeof value.role === "string" ? { role: value.role } : {}),
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.text === "string" ? { text: value.text } : {}),
    ...(typeof value.state === "string" ? { state: value.state } : {}),
    ...(typeof value.windowTitle === "string" ? { windowTitle: value.windowTitle } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs: Math.floor(timeoutMs) }),
    ...(pollMs === undefined ? {} : { pollMs: Math.floor(pollMs) }),
  }
  return Object.keys(condition).length === 0 ? undefined : condition
}

function computerUseOperation(value: unknown): ComputerUseOperation {
  return value === "ground" ||
    value === "click" ||
    value === "type" ||
    value === "scroll" ||
    value === "drag" ||
    value === "resize" ||
    value === "inspect" ||
    value === "general"
    ? value
    : "general"
}

// Caller-supplied semantic contexts and images are data, never trust
// decisions: validate the shape and drop anything that could smuggle trusted
// fields such as serverCrop.
function semanticEnvironment(value: unknown): SemanticEnvironment | undefined {
  if (!isRecord(value)) return undefined
  const coverage = finiteNumber(value.coverage, { min: 0, max: 1 })
  if (coverage === undefined || !Array.isArray(value.elements)) return undefined
  return {
    coverage,
    ...(typeof value.applicationId === "string" ? { applicationId: value.applicationId } : {}),
    ...(typeof value.windowTitle === "string" ? { windowTitle: value.windowTitle } : {}),
    elements: value.elements.filter((element): element is SemanticElement => isRecord(element)),
    ...(typeof value.text === "string" ? { text: value.text } : {}),
    ...(typeof value.backend === "string" ? { backend: value.backend } : {}),
  }
}

function imageReference(value: unknown): ImageReference | undefined {
  if (!isRecord(value)) return undefined
  const width = finiteNumber(value.width, { min: 1, max: 100_000 })
  const height = finiteNumber(value.height, { min: 1, max: 100_000 })
  if (width === undefined || height === undefined) return undefined
  const region = isRecord(value.region)
    ? {
        x: finiteNumber(value.region.x) ?? 0,
        y: finiteNumber(value.region.y) ?? 0,
        width: finiteNumber(value.region.width, { min: 1, max: 100_000 }) ?? width,
        height: finiteNumber(value.region.height, { min: 1, max: 100_000 }) ?? height,
      }
    : undefined
  return {
    width,
    height,
    ...(typeof value.path === "string" ? { path: value.path } : {}),
    ...(typeof value.dataUrl === "string" ? { dataUrl: value.dataUrl } : {}),
    ...(region === undefined ? {} : { region }),
  }
}

function computerUseContext(body: Record<string, unknown>): ComputerUseContext {
  const semantic = semanticEnvironment(body.semanticContext)
  const image = imageReference(body.image)
  const privacy: ComputerUsePrivacy | undefined = isRecord(body.privacy)
    ? {
        allowRemoteScreen: body.privacy.allowRemoteScreen === true,
        mode:
          body.privacy.mode === "local_only" || body.privacy.mode === "hosted_only" || body.privacy.mode === "ask"
            ? body.privacy.mode
            : "automatic",
      }
    : undefined
  return {
    computerId: typeof body.computerId === "string" ? body.computerId : "local",
    requestedOperation: computerUseOperation(body.requestedOperation),
    ...(typeof body.targetDescription === "string" ? { targetDescription: body.targetDescription } : {}),
    ...(semantic === undefined ? {} : { semanticContext: semantic }),
    ...(image === undefined ? {} : { image }),
    ...(privacy === undefined ? {} : { privacy }),
  }
}

// Freezing physical input is a system-level action. Agent-originated calls
// pass the UI_CONTROL boundary; only the server-token desktop operator is
// exempt, because the UI itself is the approver there.
function inputControlPermission(
  context: ApiContext,
  request: IncomingMessage,
  body: Record<string, unknown>,
): { status: number; error: string } | undefined {
  if (!isAgentRequest(context, request, body)) return undefined
  const operation: OperationInput = { action: "input.freeze", resources: [typeof body.computerId === "string" ? body.computerId : "local"] }
  const decision = context.permissions.evaluate(["UI_CONTROL"], {
    sessionId: requestSessionId(request, body),
    approval: approvalFromBody(context, request, body),
    operation,
  })
  if (decision.allowed) return undefined
  return { status: decision.status === "denied" ? 403 : 428, error: decision.reason ?? "Permission required." }
}

// Superskill summaries are returned to API clients, so the bridge launcher
// command and environment (which carry paths, arguments, and secrets) are
// never echoed back; only the bridge kind and transport limits are.
function redactSuperskill(skill: Superskill): Record<string, unknown> {
  const { bridge, ...rest } = skill
  return {
    ...rest,
    bridge: {
      type: bridge.type,
      ...(bridge.url === undefined ? {} : { url: bridge.url }),
      ...(bridge.timeoutMs === undefined ? {} : { timeoutMs: bridge.timeoutMs }),
    },
  }
}

function memoryPermission(
  context: ApiContext,
  request: IncomingMessage,
  body: Record<string, unknown>,
  scope: "FILES_READ" | "FILES_WRITE",
): { status: number; result: Record<string, unknown> } | undefined {
  if (!isAgentRequest(context, request, body)) return undefined
  const operation: OperationInput = { action: `memories_${scope === "FILES_READ" ? "read" : "write"}`, resources: ["memories"] }
  const decision = context.permissions.evaluate([scope], {
    sessionId: requestSessionId(request, body),
    approval: approvalFromBody(context, request, body),
    operation,
  })
  if (decision.allowed) return undefined
  return {
    status: decision.status === "denied" ? 403 : 428,
    result: {
      success: false,
      status: "rejected",
      message: decision.reason ?? "Permission required.",
      error: {
        code: decision.status === "denied" ? "permission_denied" : "permission_required",
        message: decision.reason ?? "Permission required.",
        retryable: decision.status !== "denied",
        details: { missing: decision.missing, fingerprint: operationFingerprint(operation) },
      },
    },
  }
}

export function eventFrame(event: ServerEvent): string {
  return `event: ${event.type}\nid: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`
}

export function writeEvent(response: ServerResponse, event: ServerEvent): boolean {
  return response.write(eventFrame(event))
}
