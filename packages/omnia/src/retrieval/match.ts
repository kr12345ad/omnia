import type { UIElement } from "../protocol"
import type { ElementMatchResult, FieldMatch, RetrievalFilters } from "./types"

const ROLE_ALIASES: Readonly<Record<string, string>> = {
  axpushbutton: "button",
  pushbutton: "button",
  axbutton: "button",
  axtextfield: "textbox",
  textfield: "textbox",
  axcheckbox: "checkbox",
  axlink: "link",
  axstatictext: "text",
  statictext: "text",
  axheading: "heading",
  axwindow: "window",
  axdialog: "dialog",
  axapplication: "application",
  axsplitbutton: "button",
  axradiobutton: "radio",
  axmenuitem: "menuitem",
  axcombobox: "combobox",
}

export function normalizeText(value: unknown): string {
  if (value === undefined || value === null) return ""
  return String(value)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")
}

export function normalizeRole(value: unknown): string {
  const normalized = normalizeText(value).replace(/\s+/g, "")
  return ROLE_ALIASES[normalized] ?? normalized
}

export function tokenize(value: unknown): readonly string[] {
  const normalized = normalizeText(value)
  return normalized.length === 0 ? [] : [...new Set(normalized.split(" ").filter((token) => token.length > 0))]
}

export function exactMatch(left: unknown, right: unknown): boolean {
  return normalizeText(left) === normalizeText(right) && normalizeText(left).length > 0
}

export function levenshtein(left: string, right: string): number {
  if (left === right) return 0
  if (left.length === 0) return right.length
  if (right.length === 0) return left.length
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  return Array.from(left).reduce((current, character, leftIndex) => {
    const next = [leftIndex + 1]
    Array.from(right).forEach((rightCharacter, rightIndex) => {
      const substitution = (current[rightIndex] ?? 0) + (character === rightCharacter ? 0 : 1)
      next[rightIndex + 1] = Math.min(
        (next[rightIndex] ?? 0) + 1,
        (current[rightIndex + 1] ?? 0) + 1,
        substitution,
      )
    })
    return next
  }, previous)[right.length] ?? Math.max(left.length, right.length)
}

export function fuzzySimilarity(left: unknown, right: unknown): number {
  const normalizedLeft = normalizeText(left)
  const normalizedRight = normalizeText(right)
  if (normalizedLeft === normalizedRight) return 1
  if (normalizedLeft.length === 0 || normalizedRight.length === 0) return 0
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) {
    return 0.9 + 0.1 * (Math.min(normalizedLeft.length, normalizedRight.length) / Math.max(normalizedLeft.length, normalizedRight.length))
  }
  const leftTokens = tokenize(normalizedLeft)
  const rightTokens = tokenize(normalizedRight)
  if (leftTokens.length > 0 && rightTokens.length > 0) {
    const overlap = leftTokens.filter((token) => rightTokens.includes(token)).length
    if (overlap > 0) {
      const coverage = overlap / Math.max(leftTokens.length, rightTokens.length)
      const order = leftTokens.join(" ") === rightTokens.join(" ") ? 0.05 : 0
      return Math.min(0.94, 0.62 + coverage * 0.28 + order)
    }
  }
  const distance = levenshtein(normalizedLeft, normalizedRight)
  return Math.max(0, 1 - distance / Math.max(normalizedLeft.length, normalizedRight.length))
}

export function fuzzyMatch(left: unknown, right: unknown, threshold = 0.55): boolean {
  return fuzzySimilarity(left, right) >= threshold
}

export const isExactMatch = exactMatch

export function roleSimilarity(expected: unknown, actual: unknown, exact = false): FieldMatch {
  if (normalizeRole(expected) === normalizeRole(actual)) return { field: "role", score: 1, exact: true }
  if (exact) return { field: "role", score: 0, exact: false }
  const score = fuzzySimilarity(expected, actual)
  return { field: "role", score, exact: false, distance: Math.round((1 - score) * 100) }
}

export function fieldSimilarity(expected: unknown, actual: unknown, exact = false): FieldMatch {
  const normalizedExpected = normalizeText(expected)
  const normalizedActual = normalizeText(actual)
  if (normalizedExpected.length === 0) return { field: "value", score: 0, exact: false }
  if (normalizedExpected === normalizedActual) return { field: "value", score: 1, exact: true }
  if (exact) return { field: "value", score: 0, exact: false }
  const distance = normalizedExpected.length === 0 || normalizedActual.length === 0
    ? Math.max(normalizedExpected.length, normalizedActual.length)
    : levenshtein(normalizedExpected, normalizedActual)
  return {
    field: "value",
    score: fuzzySimilarity(normalizedExpected, normalizedActual),
    exact: false,
    distance,
  }
}

export function filterMatches(
  element: UIElement,
  filters: RetrievalFilters,
  exact = false,
  fallback?: { readonly source?: string; readonly backend?: string },
): boolean {
  if (filters.role !== undefined && normalizeRole(element.role) !== normalizeRole(filters.role)) return false
  if (filters.name !== undefined && fieldSimilarity(filters.name, element.accessibleName ?? element.name ?? element.label, exact).score < (exact ? 1 : 0.55)) return false
  if (filters.description !== undefined && fieldSimilarity(filters.description, element.description, exact).score < (exact ? 1 : 0.55)) return false
  if (filters.value !== undefined && stableJson(filters.value) !== stableJson(element.value)) {
    if (exact || filters.value === null || element.value === null || typeof filters.value === "object" || typeof element.value === "object") return false
    if (fieldSimilarity(filters.value, element.value, false).score < 0.55) return false
  }
  if (filters.source !== undefined && normalizeText(element.source ?? element.reference?.source ?? fallback?.source) !== normalizeText(filters.source)) return false
  if (filters.backend !== undefined && normalizeText(element.backend ?? element.reference?.backend ?? fallback?.backend) !== normalizeText(filters.backend)) return false
  if (filters.includeOffscreen === false && isOffscreen(element)) return false
  return true
}

export function matchElement(
  element: UIElement,
  query = "",
  filters: RetrievalFilters = {},
  exact = false,
): ElementMatchResult {
  const fields: FieldMatch[] = []
  const values: readonly { readonly field: string; readonly value: unknown }[] = [
    { field: "name", value: element.accessibleName ?? element.name ?? element.label },
    { field: "description", value: element.description },
    { field: "value", value: element.value },
    { field: "text", value: element.text },
    { field: "id", value: element.id ?? element.reference?.elementId ?? element.reference?.id },
    { field: "role", value: element.role },
  ]
  if (query.trim().length > 0) {
    values.forEach(({ field, value }) => {
      const result = field === "role" ? roleSimilarity(query, value, exact) : fieldSimilarity(query, value, exact)
      fields.push({ ...result, field })
    })
  }
  const filterFields: readonly { readonly field: string; readonly value: unknown }[] = [
    { field: "role", value: element.role },
    { field: "name", value: element.accessibleName ?? element.name ?? element.label },
    { field: "description", value: element.description },
    { field: "value", value: element.value },
  ]
  filterFields.forEach(({ field, value }) => {
    const expected = field === "role"
      ? filters.role
      : field === "name"
        ? filters.name
        : field === "description"
          ? filters.description
          : filters.value
    if (expected === undefined) return
    const result = field === "value" && stableJson(expected) === stableJson(value)
      ? { field: "value", score: 1, exact: true }
      : field === "role"
        ? roleSimilarity(expected, value, exact)
        : fieldSimilarity(expected, value, exact || field === "value")
    fields.push({ ...result, field: `${field}Filter`, score: result.score })
  })
  const queryFields = fields.filter((field) => !field.field.endsWith("Filter"))
  const filterMatchesForFields = fields.filter((field) => field.field.endsWith("Filter"))
  const queryScore = query.trim().length === 0
    ? 0
    : Math.max(...queryFields.map((field) => field.score), 0)
  const filterScore = filterMatchesForFields.length === 0
    ? 1
    : filterMatchesForFields.reduce((total, field) => total + field.score, 0) / filterMatchesForFields.length
  const score = query.trim().length === 0 ? filterScore : queryScore * 0.78 + filterScore * 0.22
  const matchedOn = fields
    .filter((field) => field.score > 0)
    .sort((left, right) => right.score - left.score || compareText(left.field, right.field))
    .map((field) => field.field)
  const distance = queryFields
    .map((field) => field.distance)
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => left - right)[0]
  return {
    score: clamp(score),
    fields,
    matchedOn,
    ...(distance === undefined ? {} : { distance }),
  }
}

export const scoreElement = matchElement
export const scoreSemanticMatch = matchElement

export function stableJson(value: unknown): string {
  if (value === undefined) return ""
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`
  return `{${Object.keys(value as Record<string, unknown>)
    .sort(compareText)
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`
}

export function compareText(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

export function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

export function isOffscreen(element: UIElement): boolean {
  return element.states?.includes("offscreen") === true || element.states?.includes("hidden") === true
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
