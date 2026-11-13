import type { ProtoPath, ProtoPathElem } from "./types"

/**
 * A validated, canonical Omnia model path.
 *
 * The YANG module in models/omnia.yang is the source of truth. Shorthand
 * forms used by the task specification, such as
 * /omnia/computers/{id}/status, are expanded to the YANG list form
 * /omnia/computers/computer[id={id}]/status before they reach a handler.
 */
export interface ModelElem {
  readonly name: string
  readonly keys: Readonly<Record<string, string>>
}

export interface ModelPath {
  readonly elements: readonly ModelElem[]
}

export class ModelPathError extends Error {
  readonly code = "invalid_path"

  constructor(message: string) {
    super(message)
    this.name = "ModelPathError"
  }
}

const ROOT = "omnia"
const ORIGIN = "omnia"

export function parseModelPath(prefix: ProtoPath | undefined, path: ProtoPath): ModelPath {
  const left = readProtoPath(prefix)
  const right = readProtoPath(path)
  const origins = [left.origin, right.origin].filter((value): value is string => value !== undefined && value.length > 0)
  if (new Set(origins).size > 1) throw new ModelPathError("The prefix and path use different origins.")
  const origin = origins[0]
  if (origin !== undefined && origin !== ORIGIN) {
    throw new ModelPathError(`Unsupported origin ${origin}. Omnia exposes the ${ORIGIN} origin.`)
  }
  const targets = [left.target, right.target].filter((value): value is string => value !== undefined && value.length > 0)
  if (new Set(targets).size > 1) throw new ModelPathError("The prefix and path use different targets.")
  return { elements: normalize([...left.elements, ...right.elements]) }
}

export function parseModelPathString(value: string): ModelPath {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new ModelPathError("A path is required.")
  const parts = trimmed.split("/").filter((part) => part.length > 0)
  return { elements: normalize(parts.map(parseElemString)) }
}

export function formatModelPath(path: ModelPath): ProtoPath {
  return {
    origin: ORIGIN,
    elem: path.elements.map((element) => ({
      name: element.name,
      ...(Object.keys(element.keys).length === 0
        ? {}
        : { key: Object.entries(element.keys).map(([key, value]) => ({ key, value })) }),
    })),
  }
}

export function modelPathString(path: ModelPath): string {
  return `/${path.elements
    .map((element) => {
      const keys = Object.entries(element.keys)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `[${key}=${value}]`)
        .join("")
      return `${element.name}${keys}`
    })
    .join("/")}`
}

export function isKnownPath(path: ModelPath): boolean {
  const names = path.elements.map((element) => element.name)
  if (names[0] !== ROOT) return false
  const rest = names.slice(1)
  if (rest.length === 0) return true
  if (rest.length === 1) {
    return ["server", "computers", "sessions", "chat", "config"].includes(rest[0]!)
  }
  if (rest[0] === "server") {
    if (rest[1] === "execution") return rest.length === 2 || (rest.length === 3 && rest[2] === "last")
    return rest.length === 2 && ["status", "health"].includes(rest[1]!)
  }
  if (rest[0] === "computers") {
    if (rest[1] !== "computer") return false
    const computer = path.elements[2]
    if (computer === undefined) return rest.length === 2
    if (rest.length === 2) return true
    if (rest.length === 3 && computer.keys.id !== undefined) {
      return ["status", "capabilities", "sessions"].includes(rest[2]!)
    }
    return false
  }
  if (rest[0] === "sessions") {
    if (rest[1] === undefined) return true
    if (rest[1] !== "session") return false
    return rest.length === 2
  }
  if (rest[0] === "chat") {
    if (rest[1] !== "channels") return false
    if (rest[2] === undefined) return rest.length === 2
    if (rest[2] !== "channel") return false
    return rest.length === 3
  }
  if (rest[0] === "config") {
    if (rest[1] !== "permissions") return false
    if (rest[2] === undefined) return rest.length === 2
    if (rest[2] !== "scope") return false
    if (rest[3] === undefined) return rest.length === 3
    return rest.length === 4 && rest[3] === "state" && path.elements[3]?.keys.name !== undefined
  }
  return false
}

export function pathComputerId(path: ModelPath): string | undefined {
  return path.elements.find((element) => element.name === "computer")?.keys.id
}

export function pathSessionId(path: ModelPath): string | undefined {
  return path.elements.find((element) => element.name === "session")?.keys.id
}

export function pathChannelPlatform(path: ModelPath): string | undefined {
  return path.elements.find((element) => element.name === "channel")?.keys.platform
}

export function pathScopeName(path: ModelPath): string | undefined {
  return path.elements.find((element) => element.name === "scope")?.keys.name
}

export function pathKind(path: ModelPath): "server" | "computers" | "sessions" | "chat" | "config" | "root" | "unknown" {
  const top = path.elements[1]?.name
  if (top === undefined) return "root"
  if (top === "server" || top === "computers" || top === "sessions" || top === "chat" || top === "config") return top
  return "unknown"
}

export function isConfigPath(path: ModelPath): boolean {
  return pathKind(path) === "config"
}

/** True when `prefix` addresses `path` itself or one of its ancestors. */
export function isPathPrefix(prefix: ModelPath, path: ModelPath): boolean {
  if (prefix.elements.length > path.elements.length) return false
  return prefix.elements.every((left, index) => {
    const right = path.elements[index]
    if (right === undefined || left.name !== right.name) return false
    return Object.entries(left.keys).every(([key, value]) => right.keys[key] === value)
  })
}

export function pathsOverlap(left: ModelPath, right: ModelPath): boolean {
  return isPathPrefix(left, right) || isPathPrefix(right, left)
}

function readProtoPath(path: ProtoPath | undefined): {
  elements: readonly ModelElem[]
  origin?: string
  target?: string
} {
  if (path === undefined) return { elements: [] }
  const elems = path.elem ?? []
  const legacy = path.element ?? []
  const elements =
    elems.length > 0
      ? elems.map(readProtoElem)
      : legacy.filter((part) => part.length > 0).map(parseElemString)
  return {
    elements,
    ...(path.origin === undefined || path.origin.length === 0 ? {} : { origin: path.origin }),
    ...(path.target === undefined || path.target.length === 0 ? {} : { target: path.target }),
  }
}

function readProtoElem(elem: ProtoPathElem): ModelElem {
  const name = elem.name?.trim() ?? ""
  if (name.length === 0) throw new ModelPathError("A path element has no name.")
  return {
    name,
    keys: readKeyMap(elem.key),
  }
}

function readKeyMap(value: ProtoPathElem["key"]): Record<string, string> {
  if (value === undefined) return {}
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value
        .filter((entry): entry is { key: string; value: string } =>
          typeof entry === "object" && entry !== null && typeof entry.key === "string" && typeof entry.value === "string",
        )
        .map((entry) => [entry.key, entry.value]),
    )
  }
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, string>>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  )
}

function parseElemString(value: string): ModelElem {
  const match = /^([^[\]]+)(?:\[([^\]]+)\])?$/.exec(value.trim())
  if (match === null) throw new ModelPathError(`Invalid path element ${value}.`)
  const name = match[1]!.trim()
  if (name.length === 0) throw new ModelPathError("A path element has no name.")
  const keys: Record<string, string> = {}
  if (match[2] !== undefined) {
    for (const part of match[2].split(",")) {
      const [key, raw] = part.split("=", 2)
      if (key === undefined || raw === undefined || key.trim().length === 0) {
        throw new ModelPathError(`Invalid path key ${part}.`)
      }
      keys[key.trim()] = raw.trim().replace(/^"|"$/g, "")
    }
  }
  return { name, keys }
}

const KEY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  computer: ["id"],
  session: ["id"],
  channel: ["platform"],
  scope: ["name"],
}

function normalize(elements: readonly ModelElem[]): readonly ModelElem[] {
  if (elements.length === 0) throw new ModelPathError("A path is required.")
  if (elements[0]!.name !== ROOT) {
    throw new ModelPathError(`Omnia paths start with /${ROOT}.`)
  }
  const output: ModelElem[] = [elements[0]!]
  for (let index = 1; index < elements.length; index += 1) {
    const element = elements[index]!
    const next = elements[index + 1]
    // The task specification names lists with a bare id. Accept that form and
    // fold it into the YANG list element, so both spellings mean one path.
    if (element.name === "computers" && next !== undefined && next.name !== "computer") {
      output.push(element, { name: "computer", keys: { id: next.name } })
      index += 1
      continue
    }
    if (element.name === "sessions" && next !== undefined && next.name !== "session") {
      output.push(element, { name: "session", keys: { id: next.name } })
      index += 1
      continue
    }
    if (element.name === "channels" && next !== undefined && next.name !== "channel") {
      output.push(element, { name: "channel", keys: { platform: next.name } })
      index += 1
      continue
    }
    if (element.name === "permissions" && next !== undefined && next.name !== "scope") {
      output.push(element, { name: "scope", keys: { name: next.name } })
      index += 1
      continue
    }
    output.push(element)
  }
  for (const element of output) {
    const allowed = KEY_FIELDS[element.name]
    if (allowed === undefined) {
      if (Object.keys(element.keys).length > 0) {
        throw new ModelPathError(`Path element ${element.name} does not take keys.`)
      }
      continue
    }
    for (const key of Object.keys(element.keys)) {
      if (!allowed.includes(key)) throw new ModelPathError(`Path element ${element.name} has an unknown key ${key}.`)
      if ((element.keys[key] ?? "").length === 0) {
        throw new ModelPathError(`Path element ${element.name} has an empty ${key} key.`)
      }
    }
  }
  return output
}
