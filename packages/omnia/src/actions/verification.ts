import { isJsonValue } from "../protocol"
import type { ActionResult, JsonValue, Verification, VerificationEvidence } from "../protocol"
import { normalizeText, stableJson } from "../retrieval/match"
import type { VerificationKind, VerificationMode, VerificationSpec, VerificationStrategy } from "./types"

export type VerificationOptions = Omit<Partial<VerificationSpec>, "kind" | "expected" | "actual">

export function verify(spec: VerificationSpec): Verification {
  if (spec.kind === "text") return verifyText(spec)
  if (spec.kind === "window") return verifyWindow(spec)
  if (spec.kind === "value") return verifyValue(spec)
  if (spec.kind === "file") return verifyFile(spec)
  if (spec.kind === "control") return verifyControl(spec)
  if (spec.kind === "url") return verifyUrl(spec)
  return verifyState(spec)
}

export function verifyActionResult(spec: VerificationSpec): Verification
export function verifyActionResult(result: ActionResult, spec: VerificationSpec): Verification
export function verifyActionResult(
  resultOrSpec: ActionResult | VerificationSpec,
  maybeSpec?: VerificationSpec,
): Verification {
  if (isVerificationSpec(resultOrSpec)) return verify(resultOrSpec)
  if (maybeSpec !== undefined) {
    const actual = maybeSpec.actual ?? actionResultValue(maybeSpec.kind, resultOrSpec)
    return verify(actual === undefined ? maybeSpec : { ...maybeSpec, actual })
  }
  return resultOrSpec.verification ?? {
    status: "inconclusive",
    passed: false,
    verified: false,
    ok: false,
    method: "action-result",
    message: "No verification evidence was supplied.",
  }
}

export const verifyAction = verify
export const verifyResult = verifyActionResult

function actionResultValue(kind: VerificationKind, result: ActionResult): unknown {
  if (kind === "text") return result.observation?.text ?? result.metadata?.text
  if (kind === "value") return result.observation?.value ?? result.metadata?.value
  if (kind === "window") return result.observation?.metadata?.activeWindowId ?? result.observation?.metadata?.windowId ?? result.metadata?.activeWindowId ?? result.metadata?.windowId
  if (kind === "file") return result.metadata?.file
  if (kind === "control") return result.metadata?.control
  if (kind === "url") return result.metadata?.url
  return result.metadata?.state
}

export function verifyText(spec: VerificationSpec): Verification
export function verifyText(expected: unknown, actual: unknown, options?: VerificationOptions): Verification
export function verifyText(
  specOrExpected: VerificationSpec | unknown,
  actual?: unknown,
  options: VerificationOptions = {},
): Verification {
  const spec = isVerificationSpec(specOrExpected) && specOrExpected.kind === "text"
    ? specOrExpected
    : { kind: "text" as const, expected: specOrExpected, actual, ...options }
  const expected = textValue(spec.expected, spec.property)
  const observed = textValue(spec.actual, spec.property)
  if (expected === undefined || observed === undefined) return inconclusive(spec, "Text verification requires both expected and actual values.")
  const mode = spec.mode ?? "exact"
  const caseSensitive = spec.caseSensitive ?? false
  const normalize = spec.normalize ?? true
  const left = comparisonText(expected, caseSensitive, normalize)
  const right = comparisonText(observed, caseSensitive, normalize)
  const passed = mode === "exact"
    ? left === right
    : mode === "contains"
      ? right.includes(left)
      : mode === "prefix"
        ? right.startsWith(left)
        : mode === "suffix"
          ? right.endsWith(left)
          : matchesPattern(left, right, caseSensitive)
  return completed(spec, passed, expected, observed, passed ? "Text matched." : "Text did not match.")
}

export function verifyWindow(spec: VerificationSpec): Verification
export function verifyWindow(expected: unknown, actual: unknown, options?: VerificationOptions): Verification
export function verifyWindow(
  specOrExpected: VerificationSpec | unknown,
  actual?: unknown,
  options: VerificationOptions = {},
): Verification {
  const spec = isVerificationSpec(specOrExpected) && specOrExpected.kind === "window"
    ? specOrExpected
    : { kind: "window" as const, expected: specOrExpected, actual, ...options }
  const expectedRecord = windowRecord(recordValue(spec.expected))
  const actualRecord = windowRecord(recordValue(spec.actual))
  if (typeof spec.expected === "string" && actualRecord !== undefined) {
    const actualId = actualRecord.id ?? actualRecord.elementId ?? actualRecord.applicationId
    const passed = typeof actualId === "string" && normalizeText(spec.expected) === normalizeText(actualId)
    return completed(spec, passed, spec.expected, toJson(spec.actual), passed ? "Window matched." : "Window did not match.")
  }
  if (expectedRecord === undefined || actualRecord === undefined) return inconclusive(spec, "Window verification requires two structured values.")
  const fields = expectedFields(expectedRecord, ["id", "elementId", "applicationId", "windowId", "activeWindowId", "title", "role", "active", "focused", "url"])
  if (fields.length === 0) return inconclusive(spec, "Window verification has no comparable fields.")
  const mismatches = fields.filter((field) => !sameField(actualRecord[field], expectedRecord[field], spec.caseSensitive ?? false))
  const passed = mismatches.length === 0
  return completed(spec, passed, toJson(spec.expected), toJson(spec.actual), passed ? "Window matched." : `Window fields differ: ${mismatches.join(", ")}.`)
}

export function verifyValue(spec: VerificationSpec): Verification
export function verifyValue(expected: unknown, actual: unknown, options?: VerificationOptions): Verification
export function verifyValue(
  specOrExpected: VerificationSpec | unknown,
  actual?: unknown,
  options: VerificationOptions = {},
): Verification {
  const spec = isVerificationSpec(specOrExpected) && specOrExpected.kind === "value"
    ? specOrExpected
    : { kind: "value" as const, expected: specOrExpected, actual, ...options }
  if (spec.expected === undefined || spec.actual === undefined) return inconclusive(spec, "Value verification requires both expected and actual values.")
  const passed = typeof spec.expected === "number" && typeof spec.actual === "number" && spec.tolerance !== undefined
    ? Math.abs(spec.expected - spec.actual) <= Math.max(0, spec.tolerance)
    : stableJson(spec.expected) === stableJson(spec.actual)
  return completed(spec, passed, toJson(spec.expected), toJson(spec.actual), passed ? "Value matched." : "Value did not match.")
}

export function verifyFile(spec: VerificationSpec): Verification
export function verifyFile(expected: unknown, actual: unknown, options?: VerificationOptions): Verification
export function verifyFile(
  specOrExpected: VerificationSpec | unknown,
  actual?: unknown,
  options: VerificationOptions = {},
): Verification {
  const spec = isVerificationSpec(specOrExpected) && specOrExpected.kind === "file"
    ? specOrExpected
    : { kind: "file" as const, expected: specOrExpected, actual, ...options }
  const expectedRecord = recordValue(spec.expected)
  const actualRecord = recordValue(spec.actual)
  if (expectedRecord === undefined || actualRecord === undefined) {
    if (typeof spec.expected === "string" && typeof spec.actual === "string") {
      const passed = normalizeText(spec.expected) === normalizeText(spec.actual)
      return completed(spec, passed, spec.expected, spec.actual, passed ? "File path matched." : "File path did not match.")
    }
    return inconclusive(spec, "File verification requires supplied file evidence.")
  }
  const fields = expectedFields(expectedRecord, ["path", "name", "exists", "content", "contentHash", "hash", "modified", "mtime", "size", "mimeType"])
  if (fields.length === 0) return inconclusive(spec, "File verification has no comparable fields.")
  const mismatches = fields.filter((field) => !sameField(actualRecord[field], expectedRecord[field], spec.caseSensitive ?? false))
  const passed = mismatches.length === 0
  return completed(spec, passed, toJson(spec.expected), toJson(spec.actual), passed ? "File evidence matched." : `File evidence differs: ${mismatches.join(", ")}.`)
}

export function verifyControl(spec: VerificationSpec): Verification
export function verifyControl(expected: unknown, actual: unknown, options?: VerificationOptions): Verification
export function verifyControl(
  specOrExpected: VerificationSpec | unknown,
  actual?: unknown,
  options: VerificationOptions = {},
): Verification {
  const spec = isVerificationSpec(specOrExpected) && specOrExpected.kind === "control"
    ? specOrExpected
    : { kind: "control" as const, expected: specOrExpected, actual, ...options }
  const expectedRecord = controlRecord(spec.expected)
  const actualRecord = controlRecord(spec.actual)
  if (typeof spec.expected === "string" && actualRecord !== undefined) {
    const actualId = actualRecord.id ?? actualRecord.elementId ?? actualRecord.name
    const passed = typeof actualId === "string" && normalizeText(spec.expected) === normalizeText(actualId)
    return completed(spec, passed, spec.expected, toJson(spec.actual), passed ? "Control matched." : "Control did not match.")
  }
  if (expectedRecord === undefined || actualRecord === undefined) return inconclusive(spec, "Control verification requires two controls or control records.")
  const fields = expectedFields(expectedRecord, ["id", "elementId", "role", "name", "value", "enabled", "focused", "selected", "checked"])
  if (fields.length === 0) return inconclusive(spec, "Control verification has no comparable fields.")
  const mismatches = fields.filter((field) => !sameField(actualRecord[field], expectedRecord[field], spec.caseSensitive ?? false))
  const passed = mismatches.length === 0
  return completed(spec, passed, toJson(spec.expected), toJson(spec.actual), passed ? "Control matched." : `Control fields differ: ${mismatches.join(", ")}.`)
}

export function verifyUrl(spec: VerificationSpec): Verification
export function verifyUrl(expected: unknown, actual: unknown, options?: VerificationOptions): Verification
export function verifyUrl(
  specOrExpected: VerificationSpec | unknown,
  actual?: unknown,
  options: VerificationOptions = {},
): Verification {
  const spec = isVerificationSpec(specOrExpected) && specOrExpected.kind === "url"
    ? specOrExpected
    : { kind: "url" as const, expected: specOrExpected, actual, ...options }
  const expected = typeof spec.expected === "string" ? spec.expected : undefined
  const observed = typeof spec.actual === "string" ? spec.actual : undefined
  if (expected === undefined || observed === undefined) return inconclusive(spec, "URL verification requires two URL strings.")
  const mode = spec.mode ?? "exact"
  if (mode !== "exact") {
    const left = expected.toLowerCase()
    const right = (normalizeUrl(observed, undefined) ?? observed).toLowerCase()
    const passed = mode === "contains"
      ? right.includes(left)
      : mode === "prefix"
        ? right.startsWith(left)
        : mode === "suffix"
          ? right.endsWith(left)
          : matchesPattern(left, right, spec.caseSensitive ?? false)
    return completed(spec, passed, expected, observed, passed ? "URL matched." : "URL did not match.")
  }
  const left = normalizeUrl(expected, mode)
  const right = normalizeUrl(observed, mode)
  if (left === undefined || right === undefined) return completed(spec, false, expected, observed, "URL could not be parsed.")
  const passed = left === right
  return completed(spec, passed, left, right, passed ? "URL matched." : "URL did not match.")
}

export function verifyState(spec: VerificationSpec): Verification
export function verifyState(expected: unknown, actual: unknown, options?: VerificationOptions): Verification
export function verifyState(
  specOrExpected: VerificationSpec | unknown,
  actual?: unknown,
  options: VerificationOptions = {},
): Verification {
  const spec = isVerificationSpec(specOrExpected) && specOrExpected.kind === "state"
    ? specOrExpected
    : { kind: "state" as const, expected: specOrExpected, actual, ...options }
  const expectedStates = stateValues(spec.expected)
  const actualStates = stateValues(spec.actual)
  if (expectedStates === undefined || actualStates === undefined) return inconclusive(spec, "State verification requires state values.")
  const passed = [...expectedStates.entries()].every(([key, value]) => sameState(actualStates.get(key), value))
  return completed(spec, passed, toJson(spec.expected), toJson(spec.actual), passed ? "State matched." : "State did not match.")
}

export const verificationStrategies: Readonly<Record<VerificationKind, VerificationStrategy>> = {
  text: verifyText,
  window: verifyWindow,
  value: verifyValue,
  file: verifyFile,
  control: verifyControl,
  url: verifyUrl,
  state: verifyState,
}

export const strategies = verificationStrategies

export function strategyForAction(action: string): VerificationStrategy {
  const normalized = action.trim().toLowerCase().replace(/[- ]/g, "_")
  if (normalized === "type" || normalized === "paste" || normalized === "read") return verifyText
  if (normalized === "setvalue" || normalized === "select" || normalized === "increment" || normalized === "decrement") return verifyValue
  if (normalized === "open" || normalized === "launch") return verifyUrl
  if (normalized === "focus" || normalized === "toggle" || normalized === "click" || normalized === "doubleclick" || normalized === "rightclick") return verifyControl
  if (normalized === "observe" || normalized === "wait" || normalized === "find") return verifyState
  return verifyValue
}

export const verificationStrategyForAction = strategyForAction

export const verifyTextStrategy = verifyText
export const verifyWindowStrategy = verifyWindow
export const verifyValueStrategy = verifyValue
export const verifyFileStrategy = verifyFile
export const verifyControlStrategy = verifyControl
export const verifyUrlStrategy = verifyUrl
export const verifyStateStrategy = verifyState

export function isVerificationPassed(verification: Verification | undefined): boolean {
  return verification?.passed === true || verification?.verified === true || verification?.ok === true || verification?.status === "passed" || verification?.status === "success" || verification?.status === "verified"
}

function completed(
  spec: VerificationSpec,
  passed: boolean,
  expected: JsonValue | undefined,
  actual: JsonValue | undefined,
  message: string,
): Verification {
  const evidence: VerificationEvidence[] = [
    { kind: `${spec.kind}-expected`, ...(expected === undefined ? {} : { value: expected }) },
    { kind: `${spec.kind}-actual`, ...(actual === undefined ? {} : { value: actual }) },
  ]
  return {
    status: passed ? "passed" : "failed",
    passed,
    verified: passed,
    ok: passed,
    method: spec.kind,
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
    message,
    evidence,
    ...(spec.metadata === undefined ? {} : { metadata: spec.metadata }),
  }
}

function inconclusive(spec: VerificationSpec, message: string): Verification {
  return {
    status: "inconclusive",
    passed: false,
    verified: false,
    ok: false,
    method: spec.kind,
    message,
    ...(spec.expected === undefined ? {} : { expected: toJson(spec.expected) }),
    ...(spec.actual === undefined ? {} : { actual: toJson(spec.actual) }),
    ...(spec.metadata === undefined ? {} : { metadata: spec.metadata }),
  }
}

function isVerificationSpec(value: unknown): value is VerificationSpec {
  return typeof value === "object" && value !== null && "kind" in value && typeof value.kind === "string" && ["text", "window", "value", "file", "control", "url", "state"].includes(value.kind)
}

function comparisonText(value: string, caseSensitive: boolean, normalize: boolean): string {
  if (normalize) return caseSensitive ? value.trim().replace(/\s+/g, " ") : normalizeText(value)
  return caseSensitive ? value : value.toLowerCase()
}

function textValue(value: unknown, property: string | undefined): string | undefined {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (property !== undefined && isRecord(value) && typeof value[property] === "string") return value[property]
  if (isRecord(value)) {
    const selected = value.text ?? value.value ?? value.content
    if (typeof selected === "string") return selected
  }
  return undefined
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  if ("element" in value && isRecord(value.element)) return recordValue(value.element) ?? value
  if ("metadata" in value && isRecord(value.metadata) && !("id" in value)) {
    return { ...value.metadata, ...value }
  }
  return value
}

function windowRecord(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  const id = value.id ?? value.elementId ?? value.applicationId ?? value.windowId ?? value.activeWindowId
  return {
    ...value,
    ...(id === undefined ? {} : { id }),
    ...(value.windowId === undefined && value.activeWindowId !== undefined ? { windowId: value.activeWindowId } : {}),
  }
}

function controlRecord(value: unknown): Record<string, unknown> | undefined {
  const record = recordValue(value)
  if (record === undefined) return undefined
  if (isRecord(record.element)) return elementRecord(record.element)
  if (Object.hasOwn(record, "role") || Object.hasOwn(record, "states") || Object.hasOwn(record, "accessibleName")) {
    return elementRecord(record)
  }
  if (Array.isArray(record.states) || isRecord(record.state)) {
    return {
      ...record,
      ...(isRecord(record.state) ? record.state : {}),
    }
  }
  return record
}

function elementRecord(value: Record<string, unknown>): Record<string, unknown> {
  const states = Array.isArray(value.states) ? value.states.filter((item): item is string => typeof item === "string") : []
  return {
    ...(value.id === undefined ? {} : { id: value.id }),
    ...(value.role === undefined ? {} : { role: value.role }),
    ...(value.name === undefined ? {} : { name: value.name }),
    ...(value.accessibleName === undefined ? {} : { name: value.accessibleName }),
    ...(value.value === undefined ? {} : { value: value.value }),
    ...(states.length === 0 ? {} : { states }),
    ...Object.fromEntries(states.map((state) => [state, true])),
    ...(states.includes("disabled") ? { enabled: false } : {}),
    ...(isRecord(value.state) ? value.state : {}),
  }
}

function expectedFields(record: Record<string, unknown>, fields: readonly string[]): readonly string[] {
  return fields.filter((field) => Object.hasOwn(record, field))
}

function sameField(expected: unknown, actual: unknown, caseSensitive: boolean): boolean {
  if (typeof expected === "string" && typeof actual === "string") {
    return caseSensitive ? expected === actual : normalizeText(expected) === normalizeText(actual)
  }
  return stableJson(expected) === stableJson(actual)
}

function stateValues(value: unknown): Map<string, unknown> | undefined {
  if (typeof value === "string") return new Map([[value, true]])
  if (Array.isArray(value)) return new Map(value.filter((item): item is string => typeof item === "string").map((item) => [item, true]))
  if (!isRecord(value)) return undefined
  if (Array.isArray(value.states)) {
    const output = new Map<string, unknown>(value.states.filter((item): item is string => typeof item === "string").map((item) => [item, true]))
    if (isRecord(value.state)) Object.entries(value.state).forEach(([key, item]) => output.set(key, item))
    return output
  }
  return new Map(Object.entries(value))
}

function sameState(expected: unknown, actual: unknown): boolean {
  if (typeof expected === "string" && typeof actual === "string") return normalizeText(expected) === normalizeText(actual)
  return stableJson(expected) === stableJson(actual)
}

function normalizeUrl(value: string, mode: VerificationMode | undefined): string | undefined {
  try {
    const url = new URL(value)
    const normalized = `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${url.pathname}${url.search}${url.hash}`
    if (mode === "contains" || mode === "prefix" || mode === "suffix") return normalized
    return normalized.replace(/\/$/, "")
  } catch {
    return undefined
  }
}

function matchesPattern(expected: string, actual: string, caseSensitive: boolean): boolean {
  try {
    return new RegExp(expected, caseSensitive ? "" : "i").test(actual)
  } catch {
    return false
  }
}

function toJson(value: unknown): JsonValue | undefined {
  return isJsonValue(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
