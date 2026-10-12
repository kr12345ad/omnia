import { isOpenUIElement } from "@opencode-ai/core/openui"

/**
 * Helpers for components whose props are declaration shapes rather than visible
 * children: `Table(columns: Col[])`, charts (`Series[]`), select items and the
 * like. The parser resolves each of those to an element node with named props,
 * so a parent reads the shape instead of rendering it.
 */

/** The props of one declaration node, or the value itself when it is a plain object. */
export function decl(value: unknown): Record<string, unknown> | undefined {
  if (isOpenUIElement(value)) return value.props
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  return undefined
}

/** The props of every declaration node in an array prop. */
export function decls(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    const single = decl(value)
    return single ? [single] : []
  }
  return value.flatMap((item) => {
    const single = decl(item)
    return single ? [single] : []
  })
}

export function text(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return undefined
}

export function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

export function bool(value: unknown): boolean {
  return value === true || value === "true"
}

/** Numbers out of a possibly ragged array prop, skipping anything unparseable. */
export function numbers(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const parsed = num(item)
    return parsed === undefined ? [] : [parsed]
  })
}

export function strings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    const single = text(value)
    return single === undefined ? [] : [single]
  }
  return value.flatMap((item) => {
    const parsed = text(item)
    return parsed === undefined ? [] : [parsed]
  })
}

const GAPS: Record<string, string> = {
  none: "0",
  xs: "0.25rem",
  s: "0.5rem",
  m: "0.75rem",
  l: "1rem",
  xl: "1.5rem",
  "2xl": "2rem",
}

/** OpenUI Lang gap tokens mapped onto a CSS gap; `m` is the library default. */
export function gap(value: unknown): string | undefined {
  const token = text(value)
  if (token === undefined) return undefined
  return GAPS[token] ?? (num(token) !== undefined ? `${num(token)}px` : undefined)
}
