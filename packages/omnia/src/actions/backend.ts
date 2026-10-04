import type { ActionType, CapabilityState } from "../protocol"
import type { ActionBackend, ActionBackendCandidate, RankedActionBackend } from "./types"
import { compareText } from "../retrieval/match"

const ACTION_ALIASES: Readonly<Record<string, ActionType>> = {
  double_click: "doubleclick",
  "double-click": "doubleclick",
  right_click: "rightclick",
  "right-click": "rightclick",
  long_press: "longpress",
  "long-press": "longpress",
  keypress: "keypress",
  key_press: "keypress",
  press_keys: "press_keys",
  set_value: "setvalue",
  "set-value": "setvalue",
  app_launch: "launch",
  application_launch: "launch",
}

const ACTION_CAPABILITIES: Readonly<Record<ActionType, readonly string[]>> = {
  observe: ["observe", "accessibility"],
  screenshot: ["screenshot", "screen-capture"],
  click: ["mouse", "pointer"],
  doubleclick: ["mouse", "pointer"],
  rightclick: ["mouse", "pointer"],
  longpress: ["mouse", "pointer"],
  move: ["mouse", "pointer"],
  drag: ["drag", "mouse", "pointer"],
  type: ["text-input", "keyboard"],
  setvalue: ["text-input", "keyboard"],
  key: ["keyboard", "input"],
  keypress: ["keyboard", "input"],
  press: ["keyboard", "input"],
  press_keys: ["keyboard", "input"],
  scroll: ["scroll", "pointer"],
  focus: ["focus", "application-focus"],
  toggle: ["application-focus", "pointer"],
  select: ["pointer", "direct_ui_control"],
  expand: ["application-focus", "pointer"],
  collapse: ["application-focus", "pointer"],
  increment: ["direct_ui_control", "pointer"],
  decrement: ["direct_ui_control", "pointer"],
  scroll_into_view: ["direct_ui_control", "accessibility-tree"],
  dismiss: ["application-focus", "pointer"],
  wait: ["wait"],
  find: ["find", "accessibility-tree"],
  read: ["read", "accessibility-tree"],
  launch: ["launch", "application-focus"],
  open: ["browser-navigation", "filesystem"],
  close: ["application-focus", "window-management"],
  copy: ["clipboard-read", "clipboard-write"],
  paste: ["clipboard-read", "clipboard-write", "text-input"],
}

export interface BackendRankingOptions {
  readonly action?: ActionType | string
  readonly actionType?: ActionType | string
  readonly preferredBackendIds?: readonly string[]
  readonly preferredBackends?: readonly string[]
  readonly allowUnavailable?: boolean
}

export function normalizeActionType(value: string): ActionType | undefined {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "_")
  const direct = normalized as ActionType
  if (ACTION_TYPES.has(direct)) return direct
  return ACTION_ALIASES[normalized]
}

const ACTION_TYPES = new Set<ActionType>([
  "observe",
  "screenshot",
  "click",
  "doubleclick",
  "rightclick",
  "longpress",
  "move",
  "drag",
  "type",
  "setvalue",
  "key",
  "keypress",
  "press",
  "press_keys",
  "scroll",
  "focus",
  "toggle",
  "select",
  "expand",
  "collapse",
  "increment",
  "decrement",
  "dismiss",
  "wait",
  "find",
  "read",
  "launch",
  "open",
  "close",
  "copy",
  "paste",
])

export function requiredCapabilities(action: ActionType | string): readonly string[] {
  const normalized = normalizeActionType(action)
  return normalized === undefined ? [] : ACTION_CAPABILITIES[normalized]
}

export function rankActionBackends(
  inputs: readonly (ActionBackend | ActionBackendCandidate | string)[],
  action?: ActionType | string | BackendRankingOptions,
  options: BackendRankingOptions = {},
): readonly RankedActionBackend[] {
  const rankingOptions = typeof action === "object" ? action : options
  const actionType = typeof action === "string" ? action : rankingOptions.action ?? rankingOptions.actionType
  const normalizedAction = actionType === undefined ? undefined : normalizeActionType(actionType)
  const preferred = rankingOptions.preferredBackendIds ?? rankingOptions.preferredBackends ?? []
  const ranked = inputs
    .map((input) => rankOne(input, normalizedAction, preferred, rankingOptions.allowUnavailable === true))
    .sort(compareRanked)
  return ranked.map((entry, index) => ({
    ...entry,
    ...(entry.eligible ? { rank: ranked.slice(0, index).filter((candidate) => candidate.eligible).length + 1 } : {}),
  }))
}

export const rankBackends = rankActionBackends
export const rankBackendsForAction = rankActionBackends

export function selectActionBackend(
  inputs: readonly (ActionBackend | ActionBackendCandidate | string)[],
  action?: ActionType | string | BackendRankingOptions,
  options: BackendRankingOptions = {},
): RankedActionBackend | undefined {
  return rankActionBackends(inputs, action, options).find((candidate) => candidate.eligible)
}

export const selectBackend = selectActionBackend
export const chooseBackend = selectActionBackend

export function actionCapabilities(action: ActionType | string): readonly string[] {
  return requiredCapabilities(action)
}

function rankOne(
  input: ActionBackend | ActionBackendCandidate | string,
  action: ActionType | undefined,
  preferred: readonly string[],
  allowUnavailable: boolean,
): RankedActionBackend {
  const backend = normalizeBackend(input)
  const identity = backend.id ?? backend.backend
  const reasons: string[] = []
  const supports = backend.supportedActions ?? backend.supports
  const required = action === undefined ? [] : requiredCapabilities(action)
  if (backend.available === false && !allowUnavailable) reasons.push("backend is unavailable")
  if (backend.status === "unavailable" && !allowUnavailable) reasons.push("backend is unavailable")
  if (supports !== undefined && action !== undefined && !supportsAction(supports, action)) {
    reasons.push(`backend does not support ${action}`)
  }
  if (backend.capabilities !== undefined) {
    required.forEach((capability) => {
      const state = capabilityState(backend.capabilities?.[capability])
      if (state === "unavailable" || state === "false") reasons.push(`${capability} is unavailable`)
    })
  }
  backend.limitations?.forEach((limitation) => {
    if (limitation.severity === "error") reasons.push(limitation.message)
  })
  const supportBonus = action !== undefined && supports !== undefined && supportsAction(supports, action) ? 0.12 : 0
  const capabilityBonus = required.length === 0 || required.every((capability) => {
    const state = capabilityState(backend.capabilities?.[capability])
    return state === undefined || state === "available" || state === "true"
  }) ? 0.08 : 0
  const preferredBonus = preferred.includes(identity) ? 0.1 : 0
  const quality = bounded(backend.quality ?? backend.score, 0.5)
  const confidence = bounded(backend.confidence, quality)
  const responsiveness = bounded(backend.responsiveness, 0.5)
  const priority = bounded(backend.priority === undefined ? undefined : backend.priority > 1 ? backend.priority / 100 : backend.priority, 0.5)
  const score = clamp(quality * 0.35 + confidence * 0.25 + responsiveness * 0.15 + priority * 0.15 + supportBonus + capabilityBonus + preferredBonus)
  return {
    ...backend,
    score: round(score),
    eligible: reasons.length === 0,
    reasons,
  }
}

function normalizeBackend(input: ActionBackend | ActionBackendCandidate | string): ActionBackend {
  if (typeof input === "string") return { backend: input, available: true }
  return input
}

function supportsAction(supports: readonly ActionType[] | readonly string[], action: ActionType): boolean {
  const normalized = new Set(supports.map((value) => normalizeActionType(value)).filter((value): value is ActionType => value !== undefined))
  return normalized.has(action)
}

function capabilityState(value: CapabilityState | string | undefined): string | undefined {
  return value
}

function compareRanked(left: RankedActionBackend, right: RankedActionBackend): number {
  if (left.eligible !== right.eligible) return left.eligible ? -1 : 1
  if (left.score !== right.score) return right.score - left.score
  return compareText(left.id ?? left.backend, right.id ?? right.backend)
}

function bounded(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : clamp(value)
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
