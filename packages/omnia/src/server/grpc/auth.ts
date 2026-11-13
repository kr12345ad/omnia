import { timingSafeEqual } from "node:crypto"
import type { Metadata } from "@grpc/grpc-js"
import type { ClientTokenKind, GitHubProfile } from "../../auth/github"
import type { RemoteRegistry } from "../remote"
import { pathChannelPlatform, pathComputerId, pathScopeName, pathSessionId, pathKind, type ModelPath } from "./paths"
import type { GnmiAccess, GnmiStateSource } from "./state"

export interface GrpcAuth {
  isClientToken(token: string): boolean
  clientTokenKind(token: string): ClientTokenKind | undefined
  clientTokenProfile(token: string): GitHubProfile | undefined
}

export interface GrpcPrincipal {
  readonly kind: "operator" | "desktop" | "agent"
  readonly token: string
  readonly profile?: GitHubProfile
  readonly actor: string
}

export function authenticate(metadata: Metadata, token: string, auth: GrpcAuth): GrpcPrincipal | undefined {
  const values = metadata.get("authorization")
  const raw = values.find((value): value is string => typeof value === "string")
  if (raw === undefined) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim())
  const presented = match?.[1]?.trim()
  if (presented === undefined || presented.length === 0) return undefined
  if (sameSecret(presented, token)) {
    return { kind: "operator", token: presented, actor: "deployment-operator" }
  }
  if (!auth.isClientToken(presented)) return undefined
  const kind = auth.clientTokenKind(presented) ?? "agent"
  const profile = auth.clientTokenProfile(presented)
  return {
    kind,
    token: presented,
    ...(profile === undefined ? {} : { profile }),
    actor: profile === undefined ? `client:${kind}` : `${profile.provider ?? "github"}:${profile.id}`,
  }
}

export function createAccess(principal: GrpcPrincipal, remote: RemoteRegistry): GnmiAccess {
  const operator = principal.kind === "operator"
  const profile = principal.profile === undefined ? undefined : String(principal.profile.id)
  const visibleComputer = (id: string): boolean => {
    if (operator) return true
    const owner = remote.owner(id)
    if (owner !== undefined) return owner === profile
    // A runtime with no owner predates ownership binding. It is local to this
    // installation and visible only when it has no remote credential at all.
    return remote.tokenFor(id) === undefined
  }
  return {
    operator,
    chat: operator || principal.kind === "desktop",
    visibleComputer,
    visibleSession: (session) => (operator ? true : session.computerId !== undefined && visibleComputer(session.computerId)),
  }
}

/**
 * Authorize one concrete model path. Unknown paths are rejected separately as
 * invalid; this function is only about who may read or write a valid path.
 */
export function authorizePath(
  path: ModelPath,
  access: GnmiAccess,
  source: Pick<GnmiStateSource, "sessions">,
): boolean {
  const kind = pathKind(path)
  if (kind === "config") return access.operator
  if (kind === "chat") return access.chat
  if (kind === "server" || kind === "root") return true
  if (kind === "computers") {
    const id = pathComputerId(path)
    return id === undefined || access.visibleComputer(id)
  }
  if (kind === "sessions") {
    const id = pathSessionId(path)
    if (id === undefined) return true
    const session = source.sessions().find((entry) => entry.id === id)
    return session !== undefined && access.visibleSession(session)
  }
  return false
}

export function authorizeSetPath(path: ModelPath, access: GnmiAccess): boolean {
  if (!access.operator) return false
  if (pathKind(path) !== "config") return false
  // The initial subset exposes exactly one writable leaf. Everything else in
  // the schema is state and is rejected rather than silently accepted.
  return pathScopeName(path) !== undefined && path.elements.at(-1)?.name === "state"
}

export function sameSecret(left: string, right: string): boolean {
  if (right.length === 0) return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
