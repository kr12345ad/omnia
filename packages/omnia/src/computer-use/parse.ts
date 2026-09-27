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
    case "select":
      return {
        action: {
          type: "drag",
          ...(start === undefined ? {} : { target: { x: start.x, y: start.y } }),
          ...(start === undefined || end === undefined ? {} : { path: [start, end] }),
        },
        confidence: start !== undefined && end !== undefined ? 0.72 : 0.35,
        evidence: [...evidence, end === undefined ? "no end point was produced" : `end point (${end.x}, ${end.y})`],
        format: "ui-tars",
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
    case "move":
      return {
        action: {
          type: "drag",
          ...(point === undefined ? {} : { target: { x: point.x, y: point.y } }),
          ...(end === undefined || point === undefined ? {} : { path: [point, end] }),
        },
        confidence: point === undefined ? 0.35 : 0.68,
        evidence,
        format: "showui",
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
    if (image?.region !== undefined) return { x: Math.round(point.x + image.region.x), y: Math.round(point.y + image.region.y) }
    return { x: Math.round(point.x), y: Math.round(point.y) }
  }
  const scale = space === "normalized-1" ? 1 : 1000
  const x = clamp(Math.round((point.x / scale) * image.width), 0, image.width)
  const y = clamp(Math.round((point.y / scale) * image.height), 0, image.height)
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
  const direct = text.match(/Action:\s*([A-Za-z_][\w]*)\((.*)\)/s)
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
  const parsed: unknown = JSON.parse(candidate.slice(start, end + 1)) as unknown
  return isRecord(parsed) ? parsed : undefined
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
