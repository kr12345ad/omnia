import {
  COMPUTER_EVENT_TYPES,
  isActionResult,
  isCapabilitySupport,
  isComputerInfo,
  isFindResult,
  isObservation,
} from "@opencode-ai/omnia/protocol"
import type {
  ActionResult,
  CapabilitySupport,
  ComputerAction,
  ComputerInfo,
  FindResult,
  Modifier,
  Observation,
} from "@opencode-ai/omnia/protocol"
import type {
  OmniaAction,
  OmniaEvent,
  OmniaExecuteRequest,
  OmniaFindRequest,
  OmniaObserveRequest,
  OmniaTargetReference,
} from "./types"

export const OMNIA_MAX_PAYLOAD_BYTES = 64 * 1024
export const OMNIA_MAX_RESULT_BYTES = 16 * 1024 * 1024
export const OMNIA_MAX_EVENT_BYTES = 64 * 1024

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/
const SUBSCRIPTION_ID = /^[A-Za-z0-9_-]{16,128}$/
const MODIFIER_ORDER: Modifier[] = ["alt", "control", "meta", "shift"]

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function assertOmniaPayloadSize(value: unknown, limit = OMNIA_MAX_PAYLOAD_BYTES) {
  if (measureOmniaPayload(value, limit) === undefined) invalidPayload()
}

export function isOmniaPayloadWithinSize(value: unknown, limit: number) {
  return measureOmniaPayload(value, limit) !== undefined
}

export function parseOmniaSubscriptionId(value: unknown) {
  assertOmniaPayloadSize(value)
  if (typeof value !== "string" || !SUBSCRIPTION_ID.test(value)) invalidPayload()
  return value
}

export function parseOmniaObserveRequest(value: unknown = {}): OmniaObserveRequest {
  assertOmniaPayloadSize(value)
  const input = value === undefined ? {} : value
  assertShape(input, ["include", "applicationId", "source", "backend", "includeScreenshot", "includeElements"])
  if (value !== undefined && input.include !== undefined) parseStringArray(input.include, 32, 128)
  if (input.applicationId !== undefined) readIdentifier(input.applicationId, 512)
  if (input.source !== undefined) readIdentifier(input.source, 256)
  if (input.backend !== undefined) readIdentifier(input.backend, 256)
  if (input.includeScreenshot !== undefined && typeof input.includeScreenshot !== "boolean") invalidPayload()
  if (input.includeElements !== undefined && typeof input.includeElements !== "boolean") invalidPayload()
  return {
    include: input.include ? [...(input.include as string[])] : undefined,
    applicationId: input.applicationId as string | undefined,
    source: input.source as string | undefined,
    backend: input.backend as string | undefined,
    includeScreenshot: input.includeScreenshot ?? false,
    includeElements: input.includeElements ?? true,
  }
}

export function parseOmniaFindRequest(value: unknown): OmniaFindRequest {
  assertOmniaPayloadSize(value)
  assertShape(value, ["query", "role", "name", "source", "backend", "limit", "includeOffscreen", "observationId"])
  const query = readIdentifier(value.query, 512).trim()
  if (!query) invalidPayload()
  if (value.role !== undefined) readIdentifier(value.role, 256)
  if (value.name !== undefined) readIdentifier(value.name, 4_096)
  if (value.source !== undefined) readIdentifier(value.source, 256)
  if (value.backend !== undefined) readIdentifier(value.backend, 256)
  if (value.observationId !== undefined) readIdentifier(value.observationId, 512)
  if (value.limit !== undefined && !isIntegerInRange(value.limit, 1, 100)) invalidPayload()
  if (value.includeOffscreen !== undefined && typeof value.includeOffscreen !== "boolean") invalidPayload()
  return {
    query,
    role: value.role as string | undefined,
    name: value.name as string | undefined,
    source: value.source as string | undefined,
    backend: value.backend as string | undefined,
    limit: (value.limit as number | undefined) ?? 50,
    includeOffscreen: value.includeOffscreen ?? false,
    observationId: value.observationId as string | undefined,
  }
}

export function parseOmniaExecuteRequest(value: unknown): OmniaExecuteRequest {
  assertOmniaPayloadSize(value)
  assertShape(value, ["target", "action"])
  return {
    target: parseOmniaTargetReference(value.target),
    action: parseOmniaAction(value.action),
  }
}

export function parseOmniaTargetReference(value: unknown): OmniaTargetReference {
  assertOmniaPayloadSize(value)
  assertShape(value, ["elementId", "generation", "observationId", "source", "backend", "role", "expiresAt"])
  if (!isIntegerInRange(value.generation, 0, Number.MAX_SAFE_INTEGER)) invalidPayload()
  if (value.expiresAt !== undefined && !isTimestamp(value.expiresAt)) invalidPayload()
  if (value.observationId !== undefined) readIdentifier(value.observationId, 512)
  if (value.source !== undefined) readIdentifier(value.source, 256)
  if (value.backend !== undefined) readIdentifier(value.backend, 256)
  if (value.role !== undefined) readIdentifier(value.role, 256)
  return {
    elementId: readIdentifier(value.elementId, 512),
    generation: readGeneration(value.generation),
    ...(value.observationId !== undefined ? { observationId: readIdentifier(value.observationId, 512) } : {}),
    ...(value.source !== undefined ? { source: readIdentifier(value.source, 256) } : {}),
    ...(value.backend !== undefined ? { backend: readIdentifier(value.backend, 256) } : {}),
    ...(value.role !== undefined ? { role: readIdentifier(value.role, 256) } : {}),
    ...(value.expiresAt !== undefined ? { expiresAt: readTimestamp(value.expiresAt) } : {}),
  }
}

export function withOmniaTarget(action: OmniaAction, target: OmniaTargetReference): ComputerAction {
  const computerTarget = { kind: "element", elementId: target.elementId, reference: target } as const
  if (action.type === "click") return { ...action, target: computerTarget }
  if (action.type === "doubleclick") return { ...action, target: computerTarget }
  if (action.type === "rightclick") return { ...action, target: computerTarget }
  if (action.type === "type") return { ...action, target: computerTarget }
  if (action.type === "key") return { ...action, target: computerTarget }
  if (action.type === "scroll") return { ...action, target: computerTarget }
  return { ...action, target: computerTarget }
}

export function parseOmniaObservation(value: unknown): Observation {
  assertOmniaPayloadSize(value, OMNIA_MAX_RESULT_BYTES)
  if (!isObservation(value)) invalidResult()
  return structuredClone(value)
}

export function parseOmniaFindResult(value: unknown): FindResult {
  assertOmniaPayloadSize(value, OMNIA_MAX_RESULT_BYTES)
  if (!isFindResult(value)) invalidResult()
  return structuredClone(value)
}

export function parseOmniaActionResult(value: unknown): ActionResult {
  assertOmniaPayloadSize(value, OMNIA_MAX_RESULT_BYTES)
  if (!isActionResult(value)) invalidResult()
  return structuredClone(value)
}

export function parseOmniaCapabilities(value: unknown): CapabilitySupport[] {
  assertOmniaPayloadSize(value, OMNIA_MAX_RESULT_BYTES)
  if (!Array.isArray(value) || value.length > 256 || value.some((item) => !isCapabilitySupport(item))) invalidResult()
  return structuredClone(value) as CapabilitySupport[]
}

export function parseOmniaComputerInfo(value: unknown): ComputerInfo {
  assertOmniaPayloadSize(value, OMNIA_MAX_RESULT_BYTES)
  if (!isComputerInfo(value)) invalidResult()
  return structuredClone(value)
}

export function parseOmniaEvent(value: unknown): OmniaEvent | null {
  if (!isOmniaPayloadWithinSize(value, OMNIA_MAX_EVENT_BYTES) || !isRecord(value)) return null
  try {
    if (
      typeof value.id !== "string" ||
      value.id.length === 0 ||
      value.id.length > 512 ||
      CONTROL_CHARACTER.test(value.id) ||
      !isTimestamp(value.timestamp) ||
      typeof value.type !== "string" ||
      !(COMPUTER_EVENT_TYPES as readonly string[]).includes(value.type)
    ) {
      return null
    }
    if (value.computerId !== undefined) readIdentifier(value.computerId, 512)
    if (value.code !== undefined) readIdentifier(value.code, 256)
    return {
      id: value.id,
      timestamp: value.timestamp,
      type: value.type as OmniaEvent["type"],
      computerId: value.computerId as string | undefined,
      code: value.code as string | undefined,
    }
  } catch {
    return null
  }
}

export function isOmniaPermissionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !CONTROL_CHARACTER.test(value)
}

function parseOmniaAction(value: unknown): OmniaAction {
  if (!isRecord(value) || typeof value.type !== "string") invalidPayload()
  if (value.type === "click") {
    assertShape(value, ["type", "button", "count", "modifiers"])
    if (
      value.button !== undefined &&
      value.button !== "left" &&
      value.button !== "middle" &&
      value.button !== "right"
    ) {
      invalidPayload()
    }
    if (value.count !== undefined && !isIntegerInRange(value.count, 1, 3)) invalidPayload()
    return {
      type: "click",
      button: value.button as "left" | "middle" | "right" | undefined,
      count: value.count as number | undefined,
      modifiers: parseModifiers(value.modifiers),
    }
  }
  if (value.type === "doubleclick" || value.type === "rightclick") {
    assertShape(value, ["type", "button", "modifiers"])
    if (
      value.button !== undefined &&
      value.button !== "left" &&
      value.button !== "middle" &&
      value.button !== "right"
    ) {
      invalidPayload()
    }
    return {
      type: value.type,
      button: value.button as "left" | "middle" | "right" | undefined,
      modifiers: parseModifiers(value.modifiers),
    }
  }
  if (value.type === "type") {
    assertShape(value, ["type", "text"])
    if (typeof value.text !== "string" || Buffer.byteLength(value.text, "utf8") > 16 * 1024) invalidPayload()
    if (CONTROL_CHARACTER.test(value.text.replaceAll(/[\t\n\r]/g, ""))) invalidPayload()
    return { type: "type", text: value.text }
  }
  if (value.type === "key") {
    assertShape(value, ["type", "key", "modifiers"])
    return { type: "key", key: readKey(value.key), modifiers: parseModifiers(value.modifiers) }
  }
  if (value.type === "scroll") {
    assertShape(value, ["type", "deltaX", "deltaY", "amount"])
    if (
      (value.deltaX === undefined && value.deltaY === undefined && value.amount === undefined) ||
      (value.deltaX !== undefined && !isFiniteNumber(value.deltaX)) ||
      (value.deltaY !== undefined && !isFiniteNumber(value.deltaY)) ||
      (value.amount !== undefined && (!isFiniteNumber(value.amount) || value.amount < 0)) ||
      Math.abs(value.deltaX ?? 0) > 100_000 ||
      Math.abs(value.deltaY ?? 0) > 100_000 ||
      (value.amount ?? 0) > 100_000
    ) {
      invalidPayload()
    }
    return {
      type: "scroll",
      deltaX: value.deltaX as number | undefined,
      deltaY: value.deltaY as number | undefined,
      amount: value.amount as number | undefined,
    }
  }
  if (value.type === "focus") {
    assertShape(value, ["type"])
    return { type: "focus" }
  }
  invalidPayload()
}

function parseModifiers(value: unknown): Modifier[] | undefined {
  if (value === undefined) return
  if (!Array.isArray(value) || value.length > MODIFIER_ORDER.length) invalidPayload()
  if (value.some((modifier) => !MODIFIER_ORDER.includes(modifier))) invalidPayload()
  if (new Set(value).size !== value.length) invalidPayload()
  return MODIFIER_ORDER.filter((modifier) => value.includes(modifier))
}

function parseStringArray(value: unknown, maxItems: number, maxLength: number) {
  if (!Array.isArray(value) || value.length > maxItems) invalidPayload()
  const result = value.map((item) => readIdentifier(item, maxLength))
  if (new Set(result).size !== result.length) invalidPayload()
  return result
}

function readKey(value: unknown) {
  const key = readIdentifier(value, 64)
  if (key.length > 1 && !/^(?:[A-Za-z0-9]+|F\d{1,2})$/.test(key)) invalidPayload()
  return key
}

function readIdentifier(value: unknown, max: number) {
  if (typeof value !== "string" || value.length === 0 || value.length > max || CONTROL_CHARACTER.test(value)) {
    invalidPayload()
  }
  return value
}

function assertShape(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (!isRecord(value)) invalidPayload()
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))) invalidPayload()
  if (
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return !descriptor?.enumerable || !("value" in descriptor)
    })
  ) {
    invalidPayload()
  }
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function readTimestamp(value: unknown) {
  if (!isTimestamp(value)) invalidPayload()
  return value
}

function readGeneration(value: unknown) {
  if (!isIntegerInRange(value, 0, Number.MAX_SAFE_INTEGER)) invalidPayload()
  return value
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function measureOmniaPayload(
  value: unknown,
  limit: number,
  depth = 0,
  state = { nodes: 0, seen: new WeakSet<object>() },
): number | undefined {
  if (depth > 24 || ++state.nodes > 100_000) return
  if (value === null) return 4
  if (typeof value === "string") return Buffer.byteLength(value, "utf8") + 2
  if (typeof value === "number") return Number.isFinite(value) ? String(value).length + 1 : undefined
  if (typeof value === "boolean") return value ? 4 : 5
  if (value === undefined) return 0
  if (typeof value !== "object" || state.seen.has(value)) return
  state.seen.add(value)
  const total = measureObject(value, limit, depth, state)
  state.seen.delete(value)
  return total
}

function measureObject(
  value: object,
  limit: number,
  depth: number,
  state: { nodes: number; seen: WeakSet<object> },
): number | undefined {
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value)
    if (keys.length !== value.length + 1 || keys.some((key) => typeof key !== "string")) return
    let total = 2
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !("value" in descriptor)) return
      const size = measureOmniaPayload(descriptor.value, limit, depth + 1, state)
      if (size === undefined || (total += size) > limit) return
    }
    return total + (value.length > 0 ? Math.max(1, value.length) : 0)
  }
  if (!isRecord(value)) return
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== "string")) return
  let total = 2
  for (const key of keys) {
    if (typeof key !== "string") return
    if (key === "__proto__" || key === "prototype" || key === "constructor") return
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !("value" in descriptor)) return
    const size = measureOmniaPayload(descriptor.value, limit, depth + 1, state)
    if (size === undefined || (total += Buffer.byteLength(key, "utf8") + 3 + size) > limit) return
  }
  return total + Math.max(0, keys.length - 1)
}

function invalidPayload(): never {
  throw new TypeError("Invalid Omnia payload")
}

function invalidResult(): never {
  throw new TypeError("Invalid Omnia result")
}
