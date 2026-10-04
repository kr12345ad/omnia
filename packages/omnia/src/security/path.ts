import { realpathSync } from "node:fs"
import type { AccessMode, PathAccessRequest, PathDecision, PathScope, PermissionOutcome } from "./types"

export class PathScopeError extends Error {
  readonly code = "path_scope_error"

  constructor(readonly decision: PathDecision) {
    super(decision.reason)
    this.name = "PathScopeError"
  }
}

export interface PathResolution {
  readonly ok: boolean
  readonly outcome: PermissionOutcome
  readonly status: PermissionOutcome
  readonly path?: string
  readonly reason: string
}

const hasControlCharacters = (value: string) =>
  Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code < 32 || code === 127
  })
const windowsAbsolute = /^[a-zA-Z]:[\\/]/
const uncAbsolute = /^[\\/]{2}/
const percentEscape = /%[0-9a-fA-F]{2}/g

const decodeForValidation = (value: string) => {
  let decoded = value
  for (let index = 0; index < 3; index += 1) {
    if (!percentEscape.test(decoded)) break
    percentEscape.lastIndex = 0
    try {
      decoded = decodeURIComponent(decoded)
    } catch {
      break
    }
    percentEscape.lastIndex = 0
  }
  return decoded
}

const separator = (value: string) => value.replaceAll("\\", "/")

const isWindowsStyle = (value: string) => windowsAbsolute.test(value) || uncAbsolute.test(value)

const stripTrailing = (value: string, root: string) => {
  if (value === root) return value
  return value.replace(/\/+$/, "") || "/"
}

export function normalizePath(input: string, options: { readonly caseSensitive?: boolean } = {}): string {
  if (typeof input !== "string" || input.length === 0) throw new PathScopeError(invalidDecision("", "path is empty"))
  if (hasControlCharacters(input)) throw new PathScopeError(invalidDecision(input, "path contains control characters"))
  const replaced = separator(decodeForValidation(input))
  if (hasControlCharacters(replaced)) throw new PathScopeError(invalidDecision(input, "path contains encoded control characters"))
  const absolute = replaced.startsWith("/") || isWindowsStyle(replaced)
  const windows = isWindowsStyle(replaced)
  const unc = uncAbsolute.test(replaced)
  const drive = windowsAbsolute.exec(replaced)?.[0]?.slice(0, 2)
  const raw = unc ? replaced.slice(2) : drive ? replaced.slice(2) : absolute ? replaced.slice(1) : replaced
  const segments: string[] = []
  raw.split("/").forEach((segment) => {
    if (!segment || segment === ".") return
    if (segment === "..") {
      if (segments.length > 0 && segments.at(-1) !== "..") segments.pop()
      else if (!absolute) segments.push("..")
      return
    }
    segments.push(segment)
  })
  const prefix = unc ? "//" : drive ? `${drive}/` : absolute ? "/" : ""
  const normalized = `${prefix}${segments.join("/")}`
  const root = prefix === "/" ? "/" : normalized || prefix
  const result = stripTrailing(normalized || prefix || ".", root)
  return options.caseSensitive === false || windows ? result.toLowerCase() : result
}

export function isAbsolutePath(input: string): boolean {
  try {
    const value = separator(decodeForValidation(input))
    return value.startsWith("/") || isWindowsStyle(value)
  } catch {
    return false
  }
}

export function isSafePath(input: string, options: { readonly caseSensitive?: boolean } = {}): boolean {
  try {
    const value = normalizePath(input, options)
    return !(value.split("/").includes("..") || value.includes("\u0000"))
  } catch {
    return false
  }
}

export function joinPath(root: string, child: string, options: { readonly caseSensitive?: boolean } = {}): string {
  const normalizedRoot = normalizePath(root, options)
  if (isAbsolutePath(child)) return normalizePath(child, options)
  return normalizePath(`${normalizedRoot.replace(/\/+$/, "")}/${child}`, options)
}

export function isPathWithin(
  root: string,
  candidate: string,
  options: { readonly caseSensitive?: boolean } = {},
): boolean {
  try {
    const normalizedRoot = normalizePath(root, options)
    const normalizedCandidate = normalizePath(candidate, options)
    if (!isAbsolutePath(normalizedRoot) || !isAbsolutePath(normalizedCandidate)) return false
    if (normalizedCandidate.startsWith("//") && !normalizedRoot.startsWith("//")) return false
    if (normalizedRoot === "/") return true
    if (normalizedRoot.match(/^[a-z]:\/$/i)) return normalizedCandidate.startsWith(normalizedRoot)
    return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
  } catch {
    return false
  }
}

export const isWithinRoot = isPathWithin

export function relativePath(root: string, candidate: string): string {
  if (!isPathWithin(root, candidate)) throw new PathScopeError(invalidDecision(candidate, "path is outside the scope"))
  const normalizedRoot = normalizePath(root)
  const normalizedCandidate = normalizePath(candidate)
  if (normalizedRoot === "/") return normalizedCandidate.slice(1)
  return normalizedCandidate.slice(normalizedRoot.length + 1)
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const globExpression = (value: string) => {
  let result = ""
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === "*" && value[index + 1] === "*") {
      if (value[index + 2] === "/") {
        result += "(?:.*/)?"
        index += 2
      } else {
        result += ".*"
        index += 1
      }
      continue
    }
    if (character === "*") {
      result += "[^/]*"
      continue
    }
    if (character === "?") {
      result += "[^/]"
      continue
    }
    result += escapeRegExp(character ?? "")
  }
  return result
}

export function pathPatternMatches(root: string, candidate: string, pattern: string): boolean {
  try {
    const normalizedRoot = normalizePath(root)
    const normalizedCandidate = normalizePath(candidate)
    const normalizedPattern = separator(pattern.trim())
    if (!normalizedPattern || normalizedPattern === "." || normalizedPattern === "./") {
      return normalizedCandidate === normalizedRoot
    }
    if (normalizedPattern === "**") return isPathWithin(normalizedRoot, normalizedCandidate)
    if (normalizedPattern.split("/").includes("..")) return false
    const absolutePattern = normalizedPattern.startsWith("/") || isWindowsStyle(normalizedPattern)
    const patternRootRelative = absolutePattern ? normalizedPattern : `${normalizedRoot.replace(/\/+$/, "")}/${normalizedPattern}`
    return new RegExp(`^${globExpression(patternRootRelative)}$`, "s").test(normalizedCandidate)
  } catch {
    return false
  }
}

const patternsFor = (scope: PathScope, access: AccessMode): readonly string[] | undefined => {
  if (access === "read") return scope.read ?? scope.allow
  if (access === "list") return scope.list ?? scope.allow
  if (access === "search") return scope.search ?? scope.allow
  if (access === "create") return scope.create ?? scope.allow
  if (access === "write") return scope.write ?? scope.allow
  if (access === "delete") return scope.delete ?? scope.allow
  if (access === "execute") return scope.execute ?? scope.allow
  if (access === "admin") return scope.admin ?? scope.allow
  // An access mode outside the enum must not fall back to the broadest rule
  // list: an unrecognised mode grants nothing.
  return undefined
}

const invalidDecision = (path: string, reason: string): PathDecision => ({
  outcome: "blocked",
  status: "blocked",
  allowed: false,
  path,
  normalizedPath: path,
  root: "",
  access: "read",
  reason,
})

export function makePathScope(input: PathScope): PathScope {
  const root = normalizePath(input.root)
  if (!isAbsolutePath(root)) throw new PathScopeError(invalidDecision(root, "scope root must be absolute"))
  return Object.freeze({
    ...input,
    root,
    ...(input.allow === undefined ? {} : { allow: Object.freeze([...input.allow]) }),
    ...(input.read === undefined ? {} : { read: Object.freeze([...input.read]) }),
    ...(input.write === undefined ? {} : { write: Object.freeze([...input.write]) }),
    ...(input.create === undefined ? {} : { create: Object.freeze([...input.create]) }),
    ...(input.delete === undefined ? {} : { delete: Object.freeze([...input.delete]) }),
    ...(input.execute === undefined ? {} : { execute: Object.freeze([...input.execute]) }),
    ...(input.list === undefined ? {} : { list: Object.freeze([...input.list]) }),
    ...(input.search === undefined ? {} : { search: Object.freeze([...input.search]) }),
    ...(input.admin === undefined ? {} : { admin: Object.freeze([...input.admin]) }),
    ...(input.deny === undefined ? {} : { deny: Object.freeze([...input.deny]) }),
  })
}

export const createPathScope = makePathScope
export const createFileScope = makePathScope
export const createScope = makePathScope
export const fileScope = makePathScope

export function tryResolveScopedPath(root: string, requested: string): PathResolution {
  try {
    const normalizedRoot = normalizePath(root)
    if (!isAbsolutePath(normalizedRoot)) return { ok: false, outcome: "blocked", status: "blocked", reason: "scope root must be absolute" }
    const normalizedCandidate = isAbsolutePath(requested) ? normalizePath(requested) : joinPath(normalizedRoot, requested)
    if (!isPathWithin(normalizedRoot, normalizedCandidate)) {
      return { ok: false, outcome: "blocked", status: "blocked", reason: "path escapes the configured scope" }
    }
    return { ok: true, outcome: "allowed", status: "allowed", path: normalizedCandidate, reason: "path is within scope" }
  } catch {
    return { ok: false, outcome: "blocked", status: "blocked", reason: "path is invalid" }
  }
}

export function resolveScopedPath(root: string, requested: string): string {
  const result = tryResolveScopedPath(root, requested)
  if (!result.ok || result.path === undefined) throw new Error(result.reason)
  return result.path
}

export const normalizeScopedPath = resolveScopedPath
export const resolvePath = tryResolveScopedPath

const accessForOperation = (operation: string | undefined): AccessMode => {
  const value = operation?.trim().toLowerCase() ?? ""
  if (/delete|remove|unlink|destroy|drop|truncate|rm/.test(value)) return "delete"
  if (/create|make|mkdir|touch/.test(value)) return "create"
  if (/write|edit|patch|modify|save|move|rename|copy/.test(value)) return "write"
  if (/execute|exec|run|spawn|shell|bash|sh/.test(value)) return "execute"
  if (/list|readdir|directory/.test(value)) return "list"
  if (/search|find|grep|glob/.test(value)) return "search"
  if (/admin|manage|permission|chmod|chown/.test(value)) return "admin"
  return "read"
}

// Resolves symlinks even for paths that do not exist yet by resolving the
// deepest existing ancestor and re-appending the remaining segments. This
// closes the TOCTOU gap where a symlinked parent directory redirects a later
// write outside the scope.
function resolvePathSymlinks(path: string): string {
  let candidate = path
  const tail: string[] = []
  for (let index = 0; index < 64; index += 1) {
    try {
      const resolved = realpathSync.native(candidate)
      const suffix = tail.reverse().join("/")
      return suffix.length === 0 ? normalizePath(resolved) : normalizePath(`${resolved}/${suffix}`)
    } catch {
      const separatorIndex = candidate.lastIndexOf("/")
      if (separatorIndex <= 0) return path
      tail.push(candidate.slice(separatorIndex + 1))
      candidate = candidate.slice(0, separatorIndex)
    }
  }
  return path
}

export function evaluatePathAccess(scope: PathScope, request: PathAccessRequest): PathDecision {
  const access = request.access ?? accessForOperation(request.operation)
  const caseOptions = scope.caseSensitive === undefined ? {} : { caseSensitive: scope.caseSensitive }
  let root: string
  let normalizedPath: string
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(request.path)) {
    return { ...invalidDecision(request.path, "URI paths are not filesystem paths"), root: scope.root, access, status: "blocked" }
  }
  try {
    root = normalizePath(scope.root, caseOptions)
    normalizedPath = isAbsolutePath(request.path)
      ? normalizePath(request.path, caseOptions)
      : joinPath(root, request.path, caseOptions)
  } catch {
    return { ...invalidDecision(request.path, "path is invalid"), root: scope.root, access }
  }
  const base = { path: request.path, normalizedPath, root, access }
  if (!isAbsolutePath(root) || !isPathWithin(root, normalizedPath, caseOptions)) {
    return { ...base, status: "blocked", outcome: "blocked", allowed: false, reason: "path escapes the configured scope" }
  }
  // Symlinks are always resolved so a scoped path cannot escape through a
  // symlinked ancestor. An explicitly supplied realpath is authoritative and
  // fails closed when it throws; the default resolver falls back to the
  // normalized path for not-yet-existing files.
  const explicitRealpath = request.realpath ?? scope.realpath
  // The default resolver maps the candidate through the filesystem, so the
  // root has to be mapped through it as well: a scope whose root is itself a
  // symlink (/var, /tmp, linked worktrees) would otherwise compare a resolved
  // child against an unresolved root and block every path in the scope. An
  // injected resolver stays authoritative and keeps the configured root.
  const scopeRoot = explicitRealpath === undefined ? resolvePathSymlinks(root) : root
  const resolved = (() => {
    if (explicitRealpath === undefined) return resolvePathSymlinks(normalizedPath)
    try {
      return normalizePath(explicitRealpath(normalizedPath), caseOptions)
    } catch {
      return undefined
    }
  })()
  if (resolved === undefined) {
    return { ...base, status: "blocked", outcome: "blocked", allowed: false, reason: "symlink target could not be validated" }
  }
  if (!isPathWithin(scopeRoot, resolved, caseOptions)) {
    return { ...base, status: "blocked", outcome: "blocked", allowed: false, reason: "symlink target escapes the configured scope" }
  }
  normalizedPath = resolved
  const decision = { ...base, root: scopeRoot, normalizedPath }
  const denied = (scope.deny ?? []).find((pattern) => pathPatternMatches(scopeRoot, normalizedPath, pattern))
  if (denied !== undefined) return { ...decision, status: "denied", outcome: "denied", allowed: false, reason: "path matches a deny rule", pattern: denied }
  const patterns = patternsFor(scope, access)
  if (patterns === undefined || patterns.length === 0) {
    return { ...decision, status: "permission_required", outcome: "permission_required", allowed: false, reason: "no path rule grants this access" }
  }
  const matched = patterns.find((pattern) => pathPatternMatches(scopeRoot, normalizedPath, pattern))
  if (matched === undefined) {
    return { ...decision, status: "permission_required", outcome: "permission_required", allowed: false, reason: "path is not granted by the access scope" }
  }
  return { ...decision, status: "allowed", outcome: "allowed", allowed: true, reason: "path is granted by the access scope", pattern: matched }
}

export const evaluateFileAccess = evaluatePathAccess
export const checkPathAccess = evaluatePathAccess

export function isPathAllowed(scope: PathScope, request: PathAccessRequest): boolean {
  return evaluatePathAccess(scope, request).allowed
}

export function assertPathAllowed(scope: PathScope, request: PathAccessRequest): string {
  const decision = evaluatePathAccess(scope, request)
  if (!decision.allowed) throw new PathScopeError(decision)
  return decision.normalizedPath
}

export function pathScopeAllows(scope: PathScope, path: string, access: AccessMode = "read"): boolean {
  return isPathAllowed(scope, { path, access })
}

export const isPathWithinScope = isPathWithin
export const isPathContained = isPathWithin
export const isWithinScope = isPathWithin
export const resolveWithinScope = resolveScopedPath
export const normalizeFilePath = normalizePath
export const evaluateScopedPath = evaluatePathAccess
export const validatePath = tryResolveScopedPath
export type FileScope = PathScope
export type PathAccessDecision = PathDecision
