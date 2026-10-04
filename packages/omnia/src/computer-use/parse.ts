import type { ComputerUseAction, ImageReference } from "./types"

export type CoordinateSpace = "normalized-1" | "normalized-1000" | "absolute"

export interface ParsedAction {
  readonly action: ComputerUseAction
  readonly confidence: number
  readonly evidence: readonly string[]
  readonly format: string
}

interface Point {
  readonly x: number
  readonly y: number
}

const ACTION_NAMES = [
  "click",
  "left_click",
  "left_double",
  "double_click",
  "right_single",
  "right_click",
  "drag",
  "select",
  "scroll",
  "type",
  "hotkey",
  "press",
  "wait",
  "finished",
  "resize",
]

export function parseUiTarsAction(text: string, image?: ImageReference, coordinateSpace?: CoordinateSpace): ParsedAction | undefined {
  const call = extractFirstActionCall(text)
  if (call === undefined) return undefined
  const args = parseArguments(call.arguments)
  const space = coordinateSpace ?? inferCoordinateSpace(image)
  const evidence = [`model output: ${call.name}(${call.arguments.slice(0, 160)})`]
  const start = resolvePoint(args.start_box ?? args.start ?? args.point ?? args.coordinate, image, space)
  const end = resolvePoint(args.end_box ?? args.end, image, space)
  switch (call.name) {
    case "click":
    case "left_click":
      return withPoint({ type: "click" }, start, evidence, "ui-tars")
    case "left_double":
    case "double_click":
      return withPoint({ type: "double_click" }, start, evidence, "ui-tars")
    case "right_single":
    case "right_click":
      return withPoint({ type: "right_click" }, start, evidence, "ui-tars")
    case "drag":
    case "select": {
      // An incomplete drag (no end point) is not executable; fail the parse
      // instead of reporting a successful no-op drag.
      if (start === undefined || end === undefined) return undefined
      return {
        action: {
          type: "drag",
          target: { x: start.x, y: start.y },
          path: [start, end],
        },
        confidence: 0.72,
        evidence: [...evidence, `end point (${end.x}, ${end.y})`],
        format: "ui-tars",
      }
    }
    case "scroll":
      return {
        action: {
          type: "scroll",
          direction: (args.direction ?? "down").toLowerCase(),
          ...(start === undefined ? {} : { target: { x: start.x, y: start.y } }),
        },
        confidence: start === undefined ? 0.4 : 0.7,
        evidence,
        format: "ui-tars",
      }
    case "type":
      return {
        action: { type: "type", text: args.content ?? args.text ?? "" },
        confidence: (args.content ?? args.text ?? "").length > 0 ? 0.78 : 0.3,
        evidence,
        format: "ui-tars",
      }
    case "hotkey":
    case "press":
      return {
        action: { type: "key", key: args.key ?? args.keys ?? "" },
        confidence: (args.key ?? args.keys ?? "").length > 0 ? 0.75 : 0.3,
        evidence,
        format: "ui-tars",
      }
    case "resize":
      return {
        action: {
          type: "resize",
          ...(start === undefined ? {} : { target: { x: start.x, y: start.y } }),
          ...(start === undefined || end === undefined ? {} : { path: [start, end] }),
        },
        confidence: start !== undefined ? 0.6 : 0.3,
        evidence,
        format: "ui-tars",
      }
    case "wait":
      return { action: { type: "wait" }, confidence: 0.5, evidence, format: "ui-tars" }
    case "finished":
      return { action: { type: "finished" }, confidence: 0.5, evidence, format: "ui-tars" }
    default:
      return undefined
  }
}

export function parseShowUiAction(text: string, image?: ImageReference, coordinateSpace?: CoordinateSpace): ParsedAction | undefined {
  const parsed = parseJsonObject(text)
  if (parsed === undefined) return parseUiTarsAction(text, image, coordinateSpace)
  const name = typeof parsed.action === "string" ? parsed.action : typeof parsed.type === "string" ? parsed.type : undefined
  if (name === undefined) return undefined
  const space = coordinateSpace ?? inferCoordinateSpace(image)
  const raw = Array.isArray(parsed.coordinate)
    ? { x: Number(parsed.coordinate[0]), y: Number(parsed.coordinate[1]) }
    : isPointLike(parsed.point)
      ? { x: Number(parsed.point.x), y: Number(parsed.point.y) }
      : undefined
  const point = raw === undefined ? undefined : resolvePoint(raw, image, space)
  const end = isPointLike(parsed.end) ? resolvePoint({ x: Number(parsed.end.x), y: Number(parsed.end.y) }, image, space) : undefined
  const evidence = [`model output: ${JSON.stringify(parsed).slice(0, 160)}`]
  const value = typeof parsed.value === "string" ? parsed.value : typeof parsed.text === "string" ? parsed.text : undefined
  switch (name) {
    case "click":
      return withPoint({ type: "click" }, point, evidence, "showui")
    case "double_click":
      return withPoint({ type: "double_click" }, point, evidence, "showui")
    case "right_click":
      return withPoint({ type: "right_click" }, point, evidence, "showui")
    case "type":
      return { action: { type: "type", text: value ?? "" }, confidence: value === undefined ? 0.3 : 0.8, evidence, format: "showui" }
    case "scroll":
      return {
        action: { type: "scroll", direction: value ?? "down", ...(point === undefined ? {} : { target: { x: point.x, y: point.y } }) },
        confidence: 0.7,
        evidence,
        format: "showui",
      }
    case "drag":
    case "move": {
      if (point === undefined || end === undefined) return undefined
      return {
        action: {
          type: "drag",
          target: { x: point.x, y: point.y },
          path: [point, end],
        },
        confidence: 0.68,
        evidence,
        format: "showui",
      }
    }
    default:
      return undefined
  }
}

export function resolvePoint(
  raw: Point | string | undefined,
  image: ImageReference | undefined,
  space: CoordinateSpace,
): Point | undefined {
  const point = toPoint(raw)
  if (point === undefined) return undefined
  if (space === "absolute" || image === undefined) {
    const x = Number.isFinite(point.x) ? Math.round(point.x) : undefined
    const y = Number.isFinite(point.y) ? Math.round(point.y) : undefined
    if (x === undefined || y === undefined) return undefined
    // Without an image there is nothing to bound the model's raw numbers
    // against; with one, an absolute point outside the screenshot (or crop)
    // cannot be a valid target and is rejected rather than clamped.
    if (image === undefined) return { x, y }
    if (!Number.isFinite(image.width) || !Number.isFinite(image.height) || image.width <= 0 || image.height <= 0) return undefined
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return undefined
    if (image.region !== undefined) return { x: x + image.region.x, y: y + image.region.y }
    return { x, y }
  }
  if (!Number.isFinite(image.width) || !Number.isFinite(image.height) || image.width <= 0 || image.height <= 0) return undefined
  const scale = space === "normalized-1" ? 1 : 1000
  // Clamp to width-1/height-1: a coordinate exactly at the edge is off-screen.
  const x = clamp(Math.round((point.x / scale) * image.width), 0, image.width - 1)
  const y = clamp(Math.round((point.y / scale) * image.height), 0, image.height - 1)
  if (image.region !== undefined) return { x: x + image.region.x, y: y + image.region.y }
  return { x, y }
}

function toPoint(raw: Point | string | undefined): Point | undefined {
  if (raw === undefined) return undefined
  if (typeof raw === "string") {
    const match = raw.match(/\(?(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\)?/)
    if (match === null) return undefined
    return { x: Number(match[1]), y: Number(match[2]) }
  }
  if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return undefined
  return raw
}

export function inferCoordinateSpace(_image: ImageReference | undefined): CoordinateSpace {
  // All bundled local models (UI-TARS, Moondream) emit normalized coordinates.
  // Absolute is only used when a caller passes it explicitly (ShowUI).
  // Guessing absolute for small crops caused ~100px systematic errors, so
  // the fallback is always normalized-1000.
  return "normalized-1000"
}

function withPoint(base: Omit<ComputerUseAction, "target">, point: Point | undefined, evidence: readonly string[], format: string): ParsedAction {
  return {
    action: { ...base, ...(point === undefined ? {} : { target: { x: point.x, y: point.y } }) },
    confidence: point === undefined ? 0.3 : 0.72,
    evidence,
    format,
  }
}

function extractFirstActionCall(text: string): { name: string; arguments: string } | undefined {
  // Line-bounded (no /s): a greedy /s match merged multiple
  // "Action: a(...) Action: b(...)" outputs into one argument blob, while a
  // non-greedy match would stop at a ")" inside the coordinates.
  const direct = text.match(/Action:\s*([A-Za-z_][\w]*)\((.*)\)/m)
  if (direct !== null) return { name: direct[1]!.toLowerCase(), arguments: direct[2]! }
  const call = text.match(/\b([A-Za-z_][\w]*)\(([^)]*)\)/s)
  if (call === null) return undefined
  const name = call[1]!.toLowerCase()
  return ACTION_NAMES.includes(name) ? { name, arguments: call[2]! } : undefined
}

function parseArguments(input: string): Record<string, string> {
  const args: Record<string, string> = {}
  const pattern = /([A-Za-z_][\w]*)\s*=\s*(?:'([^']*)'|"([^"]*)"|([^,]+))/g
  for (const match of input.matchAll(pattern)) {
    const key = match[1]!
    const value = match[2] ?? match[3] ?? match[4] ?? ""
    args[key] = value.trim()
  }
  const numbers = input.match(/\((-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\)/)
  if (numbers !== null) {
    args.start_box = args.start_box ?? `${numbers[1]},${numbers[2]}`
  }
  return args
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = (fenced?.[1] ?? text).trim()
  const start = candidate.indexOf("{")
  const end = candidate.lastIndexOf("}")
  if (start < 0 || end <= start) return undefined
  try {
    const parsed: unknown = JSON.parse(candidate.slice(start, end + 1)) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    // Malformed JSON from a model is an expected input, not an exception.
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isPointLike(value: unknown): value is { x: unknown; y: unknown } {
  return isRecord(value) && value.x !== undefined && value.y !== undefined
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
