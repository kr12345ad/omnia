import { redactSecrets, redactText, secretFindings } from "./redaction"
import { makeProvenance } from "./provenance"
import type {
  AuditEvent,
  AuditEventType,
  DangerClassification,
  PathDecision,
  PermissionDecision,
  PermissionOutcome,
  ProvenanceInput,
} from "./types"

export interface AuditInput {
  readonly type: AuditEventType
  readonly outcome: AuditEvent["outcome"]
  readonly action?: string
  readonly resources?: readonly string[]
  readonly reason: string
  readonly actor?: string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly timestamp?: number
  readonly id?: string
}

let auditSequence = 0

const deepFreeze = <Value>(value: Value, seen = new WeakSet<object>()): Value => {
  if (value === null || typeof value !== "object" || seen.has(value as object)) return value
  seen.add(value as object)
  Reflect.ownKeys(value as object).forEach((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value as object, key)
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value, seen)
  })
  return Object.freeze(value)
}

const nextId = () => `audit_${Date.now().toString(36)}_${(auditSequence += 1).toString(36)}`

const safeText = (value: string) => redactText(value).slice(0, 512)

const hashText = (value: string) => {
  let hash = 2166136261
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

export function contentFingerprint(value: string): string {
  return hashText(value)
}

const makeEvent = (input: AuditInput): AuditEvent =>
  Object.freeze({
    id: input.id ?? nextId(),
    timestamp: input.timestamp ?? Date.now(),
    type: input.type,
    outcome: input.outcome,
    status: input.outcome,
    ...(input.action === undefined ? {} : { action: safeText(input.action) }),
    resources: Object.freeze((input.resources ?? []).map(safeText)),
    reason: safeText(input.reason),
    ...(input.actor === undefined ? {} : { actor: safeText(input.actor) }),
    metadata: deepFreeze(redactSecrets(input.metadata ?? {})),
  })

export function createAuditEvent(input: AuditInput): AuditEvent {
  return makeEvent(input)
}

export const auditEvent = createAuditEvent
export const createAudit = createAuditEvent

export function auditPermissionDecision(
  request: { readonly action?: string; readonly resources?: readonly string[] },
  decision: PermissionDecision,
  metadata: Readonly<Record<string, unknown>> = {},
): AuditEvent {
  const type: AuditEventType =
    decision.outcome === "allowed"
      ? "permission.evaluated"
      : decision.outcome === "denied"
        ? "permission.denied"
        : decision.outcome === "blocked"
          ? "permission.blocked"
          : "permission.required"
  return createAuditEvent({
    type,
    outcome: decision.outcome,
    ...(request.action === undefined ? {} : { action: request.action }),
    resources: request.resources ?? decision.resources,
    reason: decision.reason,
    metadata: {
      effect: decision.effect,
      danger: decision.danger.level,
      dangerKind: decision.danger.kind,
      requiresApproval: decision.requiresApproval,
      ...metadata,
    },
  })
}

export function auditApproval(
  action: string,
  outcome: "approved" | "permission_required" | "denied" | "blocked",
  resources: readonly string[],
  reason: string,
  metadata: Readonly<Record<string, unknown>> = {},
): AuditEvent {
  return createAuditEvent({
    type: outcome === "approved" ? "approval.granted" : "approval.denied",
    outcome,
    action,
    resources,
    reason,
    metadata,
  })
}

export function auditPathAccess(decision: PathDecision, metadata: Readonly<Record<string, unknown>> = {}): AuditEvent {
  return createAuditEvent({
    type: "file.access",
    outcome: decision.outcome,
    resources: [decision.normalizedPath],
    reason: decision.reason,
    metadata: {
      access: decision.access,
      root: decision.root,
      pattern: decision.pattern,
      ...metadata,
    },
  })
}

export function auditDangerousOperation(
  action: string,
  classification: DangerClassification,
  resources: readonly string[] = [],
  metadata: Readonly<Record<string, unknown>> = {},
): AuditEvent {
  return createAuditEvent({
    type: "dangerous.detected",
    outcome: "observed",
    action,
    resources,
    reason: classification.reasons.join(", ") || "operation classified",
    metadata: {
      dangerous: classification.dangerous,
      level: classification.level,
      kind: classification.kind,
      irreversible: classification.irreversible,
      ...metadata,
    },
  })
}

export function auditRedaction(value: unknown, metadata: Readonly<Record<string, unknown>> = {}): AuditEvent {
  const findings = secretFindings(value)
  return createAuditEvent({
    type: "secret.redacted",
    outcome: "redacted",
    reason: findings.length === 0 ? "no secret findings" : "secret values were redacted",
    metadata: {
      count: findings.length,
      kinds: [...new Set(findings.map((finding) => finding.kind))],
      ...metadata,
    },
  })
}

export function auditUntrustedContent(
  provenance: ProvenanceInput,
  kind: string,
  content: string,
  metadata: Readonly<Record<string, unknown>> = {},
): AuditEvent {
  const safeProvenance = makeProvenance(provenance)
  return createAuditEvent({
    type: "content.untrusted",
    outcome: "observed",
    action: kind,
    reason: "untrusted content retained as data",
    metadata: {
      source: safeProvenance.source,
      trust: safeProvenance.trust,
      kind,
      length: content.length,
      fingerprint: contentFingerprint(content),
      ...metadata,
    },
  })
}

export function appendAuditEvent(
  events: readonly AuditEvent[],
  event: AuditEvent,
): readonly AuditEvent[] {
  const safe = createAuditEvent({
    id: event.id,
    timestamp: event.timestamp,
    type: event.type,
    outcome: event.outcome,
    ...(event.action === undefined ? {} : { action: event.action }),
    resources: event.resources,
    reason: event.reason,
    ...(event.actor === undefined ? {} : { actor: event.actor }),
    metadata: event.metadata,
  })
  return Object.freeze([...events, safe])
}

export class AuditTrail {
  #events: AuditEvent[] = []

  record(event: AuditEvent): AuditEvent {
    const safe = createAuditEvent({
      id: event.id,
      timestamp: event.timestamp,
      type: event.type,
      outcome: event.outcome,
      ...(event.action === undefined ? {} : { action: event.action }),
      resources: event.resources,
      reason: event.reason,
      ...(event.actor === undefined ? {} : { actor: event.actor }),
      metadata: event.metadata,
    })
    this.#events.push(safe)
    return safe
  }

  add(event: AuditEvent): AuditEvent {
    return this.record(event)
  }

  list(): readonly AuditEvent[] {
    return Object.freeze([...this.#events])
  }

  clear(): void {
    this.#events = []
  }
}

export const audit = createAuditEvent
export const auditPermission = auditPermissionDecision
export const auditFileAccess = auditPathAccess
export const auditDanger = auditDangerousOperation
export const auditContent = auditUntrustedContent
export const auditSecret = auditRedaction
export const recordAuditEvent = appendAuditEvent
export type AuditEventInput = AuditInput
export type { PermissionOutcome }
