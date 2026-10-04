import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from "node:fs"
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { readdir, stat, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import type {
  ActionResult,
  CapabilityState,
  CapabilitySupport,
  CommandRequest,
  CommandResult,
  ComputerInfo,
  FindMatch,
  FindRequest,
  FindResult,
  Observation,
  UIElement,
} from "../protocol"
import { retrieveElements } from "../retrieval"
import { ATSPI_SCRIPT } from "./atspi-script"
import { CLIPBOARD_SCRIPT } from "./clipboard-script"
import { INPUT_GRAB_SCRIPT, parseInputGrabLine, type InputGrabReleasedBy } from "./input-grab-script"
import { createJsonLineHelper, type PersistentHelper } from "./persistent-helper"
import { XTEST_SCRIPT } from "./xtest-script"
import {
  detectSessionType,
  ydotoolButtonCodes,
  ydotoolKeySequence,
  ydotoolMoveArgs,
  ydotoolReleaseArgs,
  type LinuxSessionType,
} from "./wayland"

export type { InputGrabReleasedBy } from "./input-grab-script"

export type RunResult = { stdout: string; stderr: string }
export type Runner = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
  env?: Record<string, string>,
  input?: string,
) => Promise<RunResult>

export const OBSERVATION_TTL_MS = 350
export const XPROP_TIMEOUT_MS = 5000
export const ATSPI_TIMEOUT_MS = 15000
export const XTEST_TIMEOUT_MS = 15000
export const TYPE_TIMEOUT_MS = 20000
export const TYPE_CHUNK_SIZE = 400
export const CAPTURE_TIMEOUT_MS = 20000
export const CLIPBOARD_TIMEOUT_MS = 20000
export const INPUT_GRAB_TIMEOUT_MS = 5000
export const INPUT_GRAB_RELEASE_TIMEOUT_MS = 3000
export const MAX_ELEMENT_TEXT = 500
export const ATSPI_HELPER_RESTART_BACKOFF_MS = 500
export const ATSPI_HELPER_RESTART_MAX_MS = 5000

export interface InputGrabEvent {
  readonly type: "frozen" | "released"
  readonly releasedBy?: InputGrabReleasedBy
  readonly reason?: string
}

interface GrabSession {
  readonly child: ChildProcessWithoutNullStreams
  readonly reason: string | undefined
  readonly ready: Promise<{ ok: true } | { ok: false; error: string }>
  readonly resolveReady: (result: { ok: true } | { ok: false; error: string }) => void
  frozen: boolean
  settled: boolean
  notified: boolean
  requested: boolean
  releasedBy?: InputGrabReleasedBy
  buffer: string
  stderr: string
}

function createGrabSession(
  child: ChildProcessWithoutNullStreams,
  reason: string | undefined,
): GrabSession {
  let resolveReady!: (result: { ok: true } | { ok: false; error: string }) => void
  const ready = new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
    resolveReady = resolve
  })
  return { child, reason, ready, resolveReady, frozen: false, settled: false, notified: false, requested: false, buffer: "", stderr: "" }
}

export interface X11Window {
  id: string
  instance: string
  cls: string
  title: string
  pid?: number
  active: boolean
  x: number
  y: number
  width: number
  height: number
}

export interface ScreenInfo {
  width: number
  height: number
  x?: number
  y?: number
  widthMm?: number
  heightMm?: number
  scale?: number
}

export interface AtspiNode {
  path: readonly number[]
  role: string
  name?: string | null
  description?: string | null
  text?: string | null
  value?: string | null
  states: readonly string[]
  actions: readonly string[]
  bounds?: { x: number; y: number; width: number; height: number } | null
  children: readonly AtspiNode[]
}

export interface AtspiApplication {
  name?: string
  error?: string
  nodes: readonly AtspiNode[]
}

export function defaultRunner(
  file: string,
  args: readonly string[],
  timeoutMs: number,
  env?: Record<string, string>,
  input?: string,
): Promise<RunResult> {
  if (input === undefined) {
    return new Promise((resolve, reject) => {
      execFile(
        file,
        [...args],
        { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, ...env } },
        (error, stdout, stderr) => {
          if (error) reject(error)
          else resolve({ stdout: String(stdout), stderr: String(stderr) })
        },
      )
    })
  }
  // Large payloads go over stdin so they can never exceed the argv limit.
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...env },
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      if (error === undefined) resolve({ stdout, stderr })
      else reject(error)
    }
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2000)
    }, timeoutMs)
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString("utf8")).slice(0, 1024 * 1024)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4000)
    })
    child.once("error", (error) => finish(error))
    child.once("close", (code) =>
      finish(code === 0 ? undefined : new Error(`${file} exited with code ${code ?? "unknown"}: ${stderr.trim()}`)),
    )
    child.stdin.on("error", () => undefined)
    child.stdin.end(input)
  })
}

function runnerFailureReason(error: unknown): string {
  if (typeof error !== "object" || error === null) return "helper process failed"
  const record = error as { code?: unknown; signal?: unknown; stderr?: unknown; message?: unknown; killed?: unknown }
  const code = typeof record.code === "string" ? record.code : undefined
  const exitCode = typeof record.code === "number" ? record.code : undefined
  const signal = typeof record.signal === "string" ? record.signal : undefined
  const stderr = typeof record.stderr === "string" ? record.stderr.trim().slice(0, 200) : ""
  if (code === "ETIMEDOUT" || record.killed === true) return "timed out"
  // A signal death (SIGSEGV) or a bare non-zero exit must keep its cause:
  // "helper process failed" alone hid a crash that the action could survive.
  const base =
    exitCode !== undefined
      ? `helper process failed (exit ${exitCode})`
      : signal !== undefined
        ? `helper process failed (${signal})`
        : code === undefined
          ? "helper process failed"
          : `helper process failed (${code})`
  return stderr.length === 0 ? base : `${base}: ${stderr}`
}

export function parseWindowIds(output: string): string[] {
  const match = output.match(/#\s*(0x[0-9a-fA-F]+(?:,\s*0x[0-9a-fA-F]+)*)/)
  if (!match?.[1]) return []
  return match[1].split(",").map((item) => item.trim().toLowerCase())
}

export function parseActiveWindowId(output: string): string | undefined {
  const match = output.match(/window id #\s*(0x[0-9a-fA-F]+)/)
  const id = match?.[1]?.toLowerCase()
  return id === "0x0" ? undefined : id
}

export function parseXprop(output: string): { instance: string; cls: string; title: string; pid?: number } {
  const rawValue = (key: string) => {
    const line = output.split("\n").find((entry) => entry.startsWith(key))
    if (!line) return ""
    return line.slice(line.indexOf("=") + 1).trim()
  }
  const unescape = (value: string) =>
    value.replace(/\\(\\|"|[0-7]{3})/g, (_match, token: string) => {
      if (token === "\\") return "\\"
      if (token === '"') return '"'
      return String.fromCharCode(Number.parseInt(token, 8))
    })
  const strings = (value: string) =>
    value.split(/"\s*,\s*"/).map((item) => unescape(item.replace(/^"/, "").replace(/"$/, "")))
  const cls = strings(rawValue("WM_CLASS"))
  const pidMatch = output.match(/_NET_WM_PID\(CARDINAL\)\s*=\s*(\d+)/)
  return {
    instance: cls[0] ?? "",
    cls: cls[1] ?? cls[0] ?? "",
    title: strings(rawValue("WM_NAME"))[0] ?? strings(rawValue("_NET_WM_NAME"))[0] ?? "",
    ...(pidMatch?.[1] === undefined ? {} : { pid: Number(pidMatch[1]) }),
  }
}

export function parseXwininfo(output: string): { x: number; y: number; width: number; height: number } | undefined {
  const num = (key: string) => {
    const match = output.match(new RegExp(`${key}:\\s*(-?\\d+)`))
    return match?.[1] === undefined ? undefined : Number(match[1])
  }
  const x = num("Absolute upper-left X")
  const y = num("Absolute upper-left Y")
  const width = num("Width")
  const height = num("Height")
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined
  if (width <= 0 || height <= 0) return undefined
  return { x, y, width, height }
}

export function parseXrandr(output: string): { width: number; height: number } | undefined {
  const match = output.match(/^\s*\S+\s+connected\b[^\n]*?(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/m)
  if (match?.[1] === undefined || match[2] === undefined) return undefined
  return { width: Number(match[1]), height: Number(match[2]) }
}

// `xrandr --listmonitors` reports every monitor with its own offset; the
// union is the virtual screen and may start at a negative coordinate.
export function parseXrandrMonitors(
  output: string,
): { x: number; y: number; width: number; height: number } | undefined {
  const matches = [...output.matchAll(/^\s*\d+:\s+\S*\s+(\d+)\/\d+x(\d+)\/\d+([+-]\d+)([+-]\d+)/gm)]
  if (matches.length === 0) return undefined
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const match of matches) {
    const width = Number(match[1])
    const height = Number(match[2])
    const x = Number(match[3])
    const y = Number(match[4])
    if (![width, height, x, y].every(Number.isFinite) || width <= 0 || height <= 0) continue
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x + width)
    maxY = Math.max(maxY, y + height)
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || maxX <= minX || maxY <= minY) return undefined
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

export function parseXdpyinfo(output: string): { widthMm: number; heightMm: number } | undefined {
  const match = output.match(/dimensions:\s*(\d+)x(\d+)\s+pixels\s+\((\d+)x(\d+)\s+millimeters\)/)
  if (match?.[3] === undefined || match[4] === undefined) return undefined
  return { widthMm: Number(match[3]), heightMm: Number(match[4]) }
}

export function displayName(window: Pick<X11Window, "id" | "instance" | "cls" | "title">): string {
  return window.title || window.instance || window.cls || window.id
}

// A child that never spawned emits "error" then "close" and no "exit" at all,
// so waiting on "exit" alone leaves the caller pending forever.
function childExited(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>((resolve) => {
    child.once("exit", () => resolve())
    child.once("close", () => resolve())
  })
}

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await worker(items[index]!, index)
    }
  })
  await Promise.all(runners)
  return results
}

export function chunkText(text: string, size: number): string[] {
  if (text.length <= size) return [text]
  const chunks: string[] = []
  let current = ""
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
  for (const part of segmenter.segment(text)) {
    // Never split a grapheme cluster (emoji, combining marks) across chunks.
    if (current.length > 0 && current.length + part.segment.length > size) {
      chunks.push(current)
      current = ""
    }
    current += part.segment
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

export function splitCommand(input: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  let started = false
  let escaped = false
  for (const char of input.trim()) {
    if (escaped) {
      current += char
      started = true
      escaped = false
      continue
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else if (char === "\\" && quote === '"') escaped = true
      else current += char
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      // An empty quoted argument ('' or "") is a real token.
      started = true
      continue
    }
    if (char === " " || char === "\t") {
      if (started) {
        tokens.push(current)
        current = ""
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (escaped) current += "\\"
  if (started) tokens.push(current)
  return tokens
}

const KNOWN_STATES = new Set([
  "busy",
  "checked",
  "collapsed",
  "disabled",
  "editable",
  "expanded",
  "focused",
  "hidden",
  "mixed",
  "modal",
  "multiselectable",
  "offscreen",
  "pressed",
  "readonly",
  "required",
  "selected",
])

type ElementStates = NonNullable<UIElement["states"]>

function normalizeStates(states: readonly string[]): ElementStates {
  // The AT-SPI helper already emits canonical Omnia state names, including an
  // explicit "disabled" for defunct/insensitive nodes and "hidden" for
  // iconified/minimized windows; filtering keeps the protocol vocabulary.
  return states.filter((state): state is ElementStates[number] => KNOWN_STATES.has(state))
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export function atspiReference(path: readonly number[]): string {
  return `atspi:${path.join(".")}`
}

export function parseAtspiReference(elementId: string): readonly number[] | undefined {
  if (!elementId.startsWith("atspi:")) return undefined
  const raw = elementId.slice("atspi:".length)
  // "atspi:" has no path; Number("") would otherwise resolve to the desktop.
  if (raw.length === 0) return undefined
  const parts = raw.split(".").map(Number)
  if (parts.length === 0 || parts.some((part) => !Number.isInteger(part) || part < 0)) return undefined
  return parts
}

const CLICK_LIKE = new Set(["click", "press", "jump", "activate", "toggle"])

export function mapActionName(name: string): "click" | undefined {
  return CLICK_LIKE.has(name.toLowerCase()) ? "click" : undefined
}

function atspiNodeToElement(
  node: AtspiNode,
  observationId: string,
  parentId: string | undefined,
  application: string,
): UIElement {
  const id = atspiReference(node.path)
  const states = normalizeStates(node.states)
  return {
    id,
    parentId,
    role: node.role,
    name: nonEmpty(node.name),
    description: nonEmpty(node.description),
    text: nonEmpty(node.text),
    value: nonEmpty(node.value),
    bounds:
      node.bounds === undefined || node.bounds === null
        ? undefined
        : { x: node.bounds.x, y: node.bounds.y, width: node.bounds.width, height: node.bounds.height },
    states,
    actions: node.actions.flatMap((action) => (mapActionName(action) === undefined ? [] : ["click" as const])),
    source: "accessibility",
    backend: "linux-at-spi",
    reference: { kind: "element", elementId: id, observationId, source: "accessibility", backend: "linux-at-spi" },
    provenance: { source: "application", trust: "untrusted", authority: "none", backend: "linux-at-spi" },
    metadata: { application, atspiPath: [...node.path], atspiActions: [...node.actions] },
  }
}

function flattenAtspi(
  node: AtspiNode,
  observationId: string,
  parentId: string | undefined,
  application: string,
  out: UIElement[],
): void {
  const element = atspiNodeToElement(node, observationId, parentId, application)
  out.push(element)
  for (const child of node.children) flattenAtspi(child, observationId, element.id, application, out)
}

export function windowToElement(window: X11Window, observationId: string): UIElement {
  const states: ElementStates = window.active ? ["focused"] : []
  return {
    id: `x11:${window.id}`,
    role: "window",
    name: displayName(window),
    bounds: { x: window.x, y: window.y, width: window.width, height: window.height },
    states,
    actions: [],
    source: "native",
    backend: "linux-x11",
    reference: {
      kind: "element",
      elementId: `x11:${window.id}`,
      observationId,
      source: "native",
      backend: "linux-x11",
    },
    provenance: { source: "application", trust: "untrusted", authority: "none", backend: "linux-x11" },
    metadata: {
      application: window.instance || window.cls,
      active: window.active,
      ...(window.pid === undefined ? {} : { pid: window.pid }),
    },
  }
}

export interface LinuxObservationInput {
  windows: readonly X11Window[]
  applications: readonly AtspiApplication[]
  observationId: string
}

export function buildObservation(input: LinuxObservationInput): Observation {
  const elements: UIElement[] = input.windows.map((window) => windowToElement(window, input.observationId))
  const byApp = new Map<string, UIElement[]>()
  for (const app of input.applications) {
    if (!app.name) continue
    const flat: UIElement[] = []
    for (const node of app.nodes) flattenAtspi(node, input.observationId, undefined, app.name, flat)
    if (flat.length > 0) byApp.set(app.name, flat)
  }
  const atspiCount = [...byApp.values()].reduce((total, flat) => total + flat.length, 0)
  const warnings: string[] = []
  if (atspiCount === 0) warnings.push("No application exposed an accessibility tree; only window-level information is available.")
  // Rank the app that owns the focused element first so the target is never
  // buried behind background applications.
  const orderedApps = [...byApp.entries()].sort(([, a], [, b]) => {
    const aFocused = a.some((element) => (element.states ?? []).includes("focused")) ? 0 : 1
    const bFocused = b.some((element) => (element.states ?? []).includes("focused")) ? 0 : 1
    return aFocused - bFocused
  })
  return {
    id: input.observationId,
    source: "accessibility",
    backend: "linux-at-spi",
    elements: [...elements, ...orderedApps.flatMap(([, flat]) => flat)],
    text: input.windows.map((window) => displayName(window)).join("\n"),
    capabilities: {
      screen_read: "unknown",
      accessibility: atspiCount > 0 ? "available" : "unavailable",
      keyboard: "degraded",
      pointer: "degraded",
      direct_ui_control: atspiCount > 0 ? "degraded" : "unavailable",
    },
    warnings,
    provenance: { source: "system", trust: "trusted", authority: "system", backend: "linux-at-spi" },
    metadata: { windows: input.windows.length, atspiElements: atspiCount },
  }
}

// Stable content fingerprint so callers can compare observations without
// diffing every element; FNV-1a over the element identity fields.
export function observationDigest(observation: Observation): string {
  const input = (observation.elements ?? [])
    .map(
      (element) =>
        `${element.id ?? ""}:${element.role ?? ""}:${element.name ?? ""}:${(element.states ?? []).join(",")}:${element.text ?? ""}`,
    )
    .join("|")
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

export function summarizeObservation(observation: Observation, maxElements = 40): string {
  const lines = [`observation ${observation.id}: ${(observation.elements ?? []).length} elements`]
  for (const element of (observation.elements ?? []).slice(0, maxElements)) {
    const label = element.name ?? element.text ?? element.id ?? "element"
    lines.push(`- ${element.role ?? "unknown"} ${label}`)
  }
  if ((observation.elements ?? []).length > maxElements) lines.push(`… ${(observation.elements ?? []).length - maxElements} more`)
  return lines.join("\n")
}

export interface LinuxDriverOptions {
  runner?: Runner
  display?: string
  session?: LinuxSessionType
  maxApps?: number
  maxDepth?: number
  maxNodes?: number
  // Injectable persistent AT-SPI helper; production spawns the python helper
  // lazily, tests provide a deterministic fake.
  atspiHelper?: PersistentHelper
  // Set false when the caller owns display liveness (the CUA backend gates on
  // its helper readiness and X11 calls fail into empty results). Defaults to
  // probing the local socket so a stale DISPLAY is reported unavailable.
  probeDisplay?: boolean
}

// Extracts the display number from a local X11 display name. Remote
// (hostname:N) displays return undefined because the socket cannot be probed
// cheaply from here.
export function x11DisplayNumber(display: string): number | undefined {
  const match = /^(?<host>[^:]*):(?<number>\d+)(?:\.\d+)?$/.exec(display.trim())
  if (match?.groups?.number === undefined) return undefined
  const host = match.groups.host ?? ""
  if (host.length > 0 && host !== "unix") return undefined
  return Number(match.groups.number)
}

// Cheap liveness probe for a display that may have gone away while DISPLAY or
// WAYLAND_DISPLAY is still exported. Returns undefined when the environment is
// not probeable (remote host, missing runtime dir), in which case callers keep
// the env-based answer.
export function probeDisplaySocket(
  display: string | undefined,
  waylandDisplay: string | undefined,
  runtimeDir: string | undefined,
): boolean | undefined {
  if (display !== undefined && display.length > 0) {
    const number = x11DisplayNumber(display)
    if (number === undefined) return undefined
    const socket = `/tmp/.X11-unix/X${number}`
    if (existsSync(socket)) return true
    // Only claim the display is dead when the socket directory exists; an
    // environment without a local X socket at all is not probeable and keeps
    // the env-based answer.
    if (!existsSync("/tmp/.X11-unix")) return undefined
    // Xorg also listens on an abstract socket that has no filesystem entry;
    // /proc/net/unix lists it. That table is Linux-specific and cheap to read.
    try {
      return readFileSync("/proc/net/unix", "utf8").includes(`@/tmp/.X11-unix/X${number}`)
    } catch {
      return undefined
    }
  }
  if (waylandDisplay !== undefined && waylandDisplay.length > 0) {
    if (waylandDisplay.startsWith("/")) return existsSync(waylandDisplay)
    if (runtimeDir === undefined || runtimeDir.length === 0) return undefined
    return existsSync(join(runtimeDir, waylandDisplay))
  }
  return undefined
}

// Shell metacharacters that need a real shell: pipes, redirection, command
// separators, substitution, globbing. Anything else runs argv-style so agent
// text is never re-interpreted by the shell.
const SHELL_METACHARACTERS = /[|&;<>()$`\n\\*?[\]{}~!]/

export function commandRequiresShell(command: string): boolean {
  return SHELL_METACHARACTERS.test(command)
}

export const MAX_X11_WINDOWS = 64
export const MAX_ARG_TEXT = 60000

export class LinuxHostDriver {
  readonly id = "linux-host"
  readonly backend = "linux-at-spi"
  private readonly runner: Runner
  private readonly display: string | undefined
  private readonly maxApps: number
  private readonly maxDepth: number
  private readonly maxNodes: number
  private observationCount = 0
  private captureStatus: CapabilityState = "unknown"
  private cachedObservation: { observation: Observation; at: number } | undefined
  private grabSession: GrabSession | undefined
  private lastGrabReleasedBy: InputGrabReleasedBy | undefined
  private readonly grabListeners = new Set<(event: InputGrabEvent) => void>()
  readonly session: LinuxSessionType
  private ydotoolProbe: boolean | undefined
  private pythonPromise: Promise<string> | undefined
  private clipboardHolders = new Set<ReturnType<typeof spawn>>()
  private atspiTruncated = false
  private atspiError: string | undefined
  private readonly injectedAtspiHelper: PersistentHelper | undefined
  private atspiHelper: PersistentHelper | undefined
  private atspiHelperPending: Promise<PersistentHelper | undefined> | undefined
  private atspiFailures = 0
  private atspiRetryAt = 0
  private disposed = false
  private readonly probeDisplay: boolean
  windowListTruncated = false

  constructor(options: LinuxDriverOptions = {}) {
    this.runner = options.runner ?? defaultRunner
    this.display = options.display ?? process.env.DISPLAY
    this.maxApps = options.maxApps ?? 25
    this.maxDepth = options.maxDepth ?? 12
    this.maxNodes = options.maxNodes ?? 2000
    this.session = options.session ?? detectSessionType()
    this.injectedAtspiHelper = options.atspiHelper
    this.probeDisplay = options.probeDisplay !== false
    if (this.session === "wayland") void this.probeYdotool()
  }

  get available(): boolean {
    if (process.platform !== "linux") return false
    const display = this.display
    const wayland = process.env.WAYLAND_DISPLAY
    const hasEnv =
      (display !== undefined && display.length > 0) || (wayland !== undefined && wayland.length > 0)
    if (!hasEnv) return false
    if (!this.probeDisplay) return true
    // A DISPLAY variable outlives the X server it named. Probe the local
    // sockets so capabilities do not claim a dead display; unprobeable remote
    // displays (or a missing runtime dir) keep the env-based answer.
    const probes: Array<boolean | undefined> = []
    if (display !== undefined && display.length > 0) {
      probes.push(probeDisplaySocket(display, undefined, undefined))
    }
    if (wayland !== undefined && wayland.length > 0) {
      probes.push(probeDisplaySocket(undefined, wayland, process.env.XDG_RUNTIME_DIR))
    }
    if (probes.some((probe) => probe === true)) return true
    if (probes.length > 0 && probes.every((probe) => probe === false)) return false
    return true
  }

  // Prefer python3 but accept a python-only install; every helper is python,
  // so an explicit error at first use is clearer than an ENOENT deep inside a
  // snapshot.
  private resolvePython(): Promise<string> {
    this.pythonPromise =
      this.pythonPromise ??
      (async () => {
        for (const candidate of ["python3", "python"]) {
          const found = await this.runner("which", [candidate], XPROP_TIMEOUT_MS, this.env()).then(
            () => true,
            () => false,
          )
          if (found) return candidate
        }
        return "python3"
      })()
    return this.pythonPromise
  }

  private async probeYdotool(): Promise<boolean> {
    if (this.ydotoolProbe !== undefined) return this.ydotoolProbe
    // The binary existing is not enough: the daemon socket must answer, or
    // every action fails after capabilities claimed input was available.
    const probe = await this.runner("which", ["ydotool"], XPROP_TIMEOUT_MS, this.env())
      .then(
        () =>
          this.runner("ydotool", ["type", ""], XPROP_TIMEOUT_MS, this.env()).then(
            () => true,
            () => false,
          ),
        () => false,
      )
    this.ydotoolProbe = probe
    return probe
  }

  private async waylandInput(): Promise<boolean> {
    if (this.session !== "wayland") return false
    return this.probeYdotool()
  }

  private async ydotoolRun(commands: readonly (readonly string[])[], timeoutMs = XTEST_TIMEOUT_MS): Promise<ActionResult> {
    for (const command of commands) {
      try {
        await this.runner("ydotool", [...command], timeoutMs, this.env())
      } catch (error) {
        return this.inputFailure(`Wayland input failed: ${runnerFailureReason(error)}`, "input_failed")
      }
    }
    return { success: true, status: "success", message: "Sent Wayland input." }
  }

  private env(): Record<string, string> {
    return this.display === undefined ? {} : { DISPLAY: this.display }
  }

  async windows(): Promise<X11Window[]> {
    if (!this.available) return []
    const env = this.env()
    const run = (file: string, args: readonly string[]) =>
      this.runner(file, args, XPROP_TIMEOUT_MS, env).catch(() => undefined)
    const [list, active] = await Promise.all([
      run("xprop", ["-root", "_NET_CLIENT_LIST"]),
      run("xprop", ["-root", "_NET_ACTIVE_WINDOW"]),
    ])
    if (!list) return []
    const allIds = parseWindowIds(list.stdout)
    const ids = allIds.slice(0, MAX_X11_WINDOWS)
    this.windowListTruncated = allIds.length > ids.length
    const activeId = active ? parseActiveWindowId(active.stdout) : undefined
    // Probe windows concurrently; sequential probing is the main latency source
    // on desktops with many windows.
    const probed = await mapLimit(ids, 8, async (id) => {
      const [props, geometry] = await Promise.all([
        run("xprop", ["-id", id, "WM_CLASS", "WM_NAME", "_NET_WM_NAME", "_NET_WM_PID"]),
        run("xwininfo", ["-id", id]),
      ])
      if (!props) return undefined
      const parsed = parseXprop(props.stdout)
      if (!parsed.instance && !parsed.cls && !parsed.title) return undefined
      const bounds = geometry === undefined ? undefined : parseXwininfo(geometry.stdout)
      // A window without readable geometry has no clickable coordinates; a
      // (0, 0) fallback would silently target the corner of the screen.
      if (bounds === undefined) return undefined
      return {
        id,
        ...parsed,
        active: activeId === id,
        ...bounds,
      } satisfies X11Window
    })
    return probed.filter((window): window is X11Window => window !== undefined)
  }

  async activeWindowId(): Promise<string | undefined> {
    if (!this.available) return undefined
    const result = await this.runner("xprop", ["-root", "_NET_ACTIVE_WINDOW"], XPROP_TIMEOUT_MS, this.env()).catch(
      () => undefined,
    )
    return result === undefined ? undefined : parseActiveWindowId(result.stdout)
  }

  private noteAtspiFailure(): void {
    this.atspiFailures += 1
    const backoff = Math.min(
      ATSPI_HELPER_RESTART_BACKOFF_MS * 2 ** Math.min(this.atspiFailures - 1, 4),
      ATSPI_HELPER_RESTART_MAX_MS,
    )
    this.atspiRetryAt = Date.now() + backoff
  }

  // One long-lived python/pyatspi process serves every observation, so the
  // registry startup cost is paid once. A crashed helper is dropped and the
  // restart is gated behind a backoff so a crash loop cannot spawn a new
  // python process on every request.
  private ensureAtspiHelper(): Promise<PersistentHelper | undefined> {
    if (this.injectedAtspiHelper !== undefined) return Promise.resolve(this.injectedAtspiHelper)
    if (this.disposed) return Promise.resolve(undefined)
    if (this.atspiHelper !== undefined) {
      if (!this.atspiHelper.exited) return Promise.resolve(this.atspiHelper)
      this.atspiHelper = undefined
      this.noteAtspiFailure()
    }
    if (this.atspiHelperPending !== undefined) return this.atspiHelperPending
    if (Date.now() < this.atspiRetryAt) return Promise.resolve(undefined)
    this.atspiHelperPending = this.resolvePython()
      .then((interpreter) =>
        createJsonLineHelper({
          script: ATSPI_SCRIPT,
          label: "The AT-SPI helper",
          interpreter,
          env: this.env(),
          timeoutMs: ATSPI_TIMEOUT_MS,
        }),
      )
      .then((helper) => {
        if (this.disposed) {
          // dispose() ran while the helper was spawning; kill the late helper
          // instead of leaking an orphan process.
          void helper.dispose()
          return undefined
        }
        this.atspiHelper = helper
        this.atspiFailures = 0
        this.atspiRetryAt = 0
        return helper
      })
      .catch(() => {
        this.noteAtspiFailure()
        return undefined
      })
      .finally(() => {
        this.atspiHelperPending = undefined
      })
    return this.atspiHelperPending
  }

  async atspiApplications(): Promise<AtspiApplication[]> {
    if (!this.available) return []
    this.atspiError = undefined
    const helper = await this.ensureAtspiHelper()
    if (helper === undefined) {
      this.atspiError = "The AT-SPI helper could not be started."
      return []
    }
    const response = await helper
      .request("snapshot", {
        max_apps: this.maxApps,
        max_depth: this.maxDepth,
        max_nodes: this.maxNodes,
      })
      .then(
        (line) => line,
        (error: unknown) => {
          this.atspiError = `The AT-SPI helper failed: ${error instanceof Error ? error.message : "helper process failed"}`
          return undefined
        },
      )
    if (response === undefined) {
      this.atspiError = this.atspiError ?? "The AT-SPI helper did not return a snapshot."
      return []
    }
    if (!response.ok) {
      this.atspiError = `The AT-SPI helper failed: ${response.error ?? "helper process failed"}`
      return []
    }
    this.atspiTruncated = response.payload.truncated === true
    const applications = response.payload.applications
    if (!Array.isArray(applications)) {
      this.atspiError = "The AT-SPI helper returned invalid output."
      return []
    }
    return applications.flatMap((app): AtspiApplication[] => {
      if (typeof app !== "object" || app === null) return []
      const record = app as Record<string, unknown>
      return [
        {
          name: typeof record.name === "string" && record.name.length > 0 ? record.name : undefined,
          error: typeof record.error === "string" ? record.error : undefined,
          nodes: Array.isArray(record.nodes) ? (record.nodes as AtspiNode[]) : [],
        },
      ]
    })
  }

  invalidateObservation(): void {
    this.cachedObservation = undefined
  }

  async observe(applicationId?: string): Promise<Observation> {
    // Reuse a very recent unfiltered observation so one action does not pay
    // for several identical full-tree walks. Actions invalidate explicitly.
    const now = Date.now()
    if (
      applicationId === undefined &&
      this.cachedObservation !== undefined &&
      now - this.cachedObservation.at < OBSERVATION_TTL_MS
    ) {
      return this.stampObservation(this.cachedObservation.observation, true, now - this.cachedObservation.at)
    }
    this.observationCount += 1
    const observationId = `obs-${this.observationCount}`
    const [windows, applications] = await Promise.all([this.windows(), this.atspiApplications()])
    const decorate = (observation: Observation): Observation => {
      const warnings = [...(observation.warnings ?? [])]
      if (this.atspiError !== undefined) warnings.push(this.atspiError)
      if (this.atspiTruncated) {
        warnings.push("The accessibility tree was truncated at the helper's node or child limit; some elements are missing.")
      }
      if (this.windowListTruncated) {
        warnings.push(`Only the first ${MAX_X11_WINDOWS} X11 windows were listed; later windows are missing.`)
      }
      return warnings.length === (observation.warnings ?? []).length ? observation : { ...observation, warnings }
    }
    if (applicationId === undefined) {
      const observation = this.stampObservation(
        decorate(buildObservation({ windows, applications, observationId })),
        false,
        0,
      )
      this.cachedObservation = { observation, at: Date.now() }
      return observation
    }
    const query = applicationId.toLowerCase()
    const matches = (value: string | undefined) => value !== undefined && value.toLowerCase().includes(query)
    const filteredApplications = applications.filter((app) => matches(app.name))
    const filteredWindows = windows.filter(
      (window) => matches(window.instance) || matches(window.cls) || matches(window.title),
    )
    if (filteredApplications.length === 0 && filteredWindows.length === 0) {
      const observation = this.stampObservation(
        decorate(buildObservation({ windows, applications, observationId })),
        false,
        0,
      )
      return {
        ...observation,
        warnings: [
          ...(observation.warnings ?? []),
          `No application matched "${applicationId}"; showing all windows and applications.`,
        ],
      }
    }
    return this.stampObservation(
      decorate(buildObservation({ windows: filteredWindows, applications: filteredApplications, observationId })),
      false,
      0,
    )
  }

  // Cached observations are replayed within the TTL; the generation, content
  // hash, and cache age let consumers tell a replayed tree from a fresh walk
  // and detect stale targets.
  private stampObservation(observation: Observation, cached: boolean, ageMs: number): Observation {
    return {
      ...observation,
      metadata: {
        ...(observation.metadata ?? {}),
        observationGeneration: this.observationCount,
        observationHash: observationDigest(observation),
        observationCached: cached,
        observationAgeMs: Math.max(0, Math.round(ageMs)),
      },
    }
  }

  async find(request: FindRequest): Promise<FindResult> {
    const observation = await this.observe()
    const result = retrieveElements(observation.elements ?? [], {
      query: request.query,
      role: request.role,
      name: request.name,
      limit: request.limit ?? 10,
    })
    const matches: FindMatch[] = result.matches.map((match) => ({
      element: match.element,
      score: match.score,
      ...(match.reference === undefined ? {} : { reference: match.reference }),
      reason: match.reason,
    }))
    return {
      query: request.query,
      matches,
      results: matches,
      elements: matches.map((match) => match.element),
      references: matches.flatMap((match) => (match.reference === undefined ? [] : [match.reference])),
      observation,
      truncated: result.truncated,
      metadata: { strategy: "deterministic-semantic" },
    }
  }

  capabilities(): CapabilitySupport[] {
    const capture = this.captureStatus
    const wayland = this.session === "wayland"
    const waylandInputReady = wayland && this.ydotoolProbe === true
    const waylandInputUnknown = wayland && this.ydotoolProbe === undefined
    const inputStatus: CapabilityState = waylandInputReady || !wayland ? "available" : "degraded"
    const inputReason = wayland
      ? waylandInputReady
        ? "Input is injected through ydotool, which works for native Wayland windows."
        : waylandInputUnknown
          ? "Wayland input is attempted through ydotool on first use; install ydotool if it is missing."
          : "Wayland input needs ydotool (and its daemon) to reach native Wayland windows; XTest only reaches XWayland apps."
      : "XTest global keyboard and pointer control works for any X11 application, whether or not it exposes accessibility."
    return [
      {
        capability: "screen_read",
        status: capture,
        score: capture === "available" ? 0.9 : 0,
        reason:
          capture === "available"
            ? wayland
              ? "Screen capture is available through spectacle or grim on Wayland."
              : "Screen capture is available through spectacle or ffmpeg."
            : capture === "unavailable"
              ? "No screen capture backend is installed (expected spectacle, grim, or ffmpeg)."
              : "Screen capture is attempted through spectacle or ffmpeg on first use.",
      },
      {
        capability: "screen_info",
        status: "available",
        score: 0.8,
        reason: "Screen geometry is read from xrandr or xwininfo; coordinates are absolute screen pixels.",
      },
      {
        capability: "accessibility",
        status: "available",
        score: 0.6,
        reason: "AT-SPI trees are used when applications expose them; otherwise window-level data and global input remain available.",
      },
      {
        capability: "keyboard",
        status: inputStatus,
        score: waylandInputReady || !wayland ? 0.9 : 0.3,
        reason: inputReason,
      },
      {
        capability: "pointer",
        status: inputStatus,
        score: waylandInputReady || !wayland ? 0.9 : 0.3,
        reason: inputReason,
      },
      {
        capability: "direct_ui_control",
        status: inputStatus,
        score: waylandInputReady || !wayland ? 0.85 : 0.3,
        reason: wayland
          ? `Semantic AT-SPI actions where available, with ${waylandInputReady ? "ydotool" : "limited"} input fallback.`
          : "Semantic AT-SPI actions where available, with global keyboard and pointer fallback everywhere else.",
      },
      {
        capability: "launch",
        status: "available",
        score: 0.9,
        reason: "Applications are launched with accessibility enabled so new windows expose semantic trees.",
      },
      {
        capability: "activate",
        status: "available",
        score: wayland ? 0.5 : 0.9,
        reason: wayland
          ? "On Wayland, window activation works through AT-SPI for applications that expose it."
          : "Windows can be raised and focused through the window manager.",
      },
      {
        capability: "clipboard",
        status: "available",
        score: 0.85,
        reason: "Text copy and paste through the GTK clipboard; keyboard copy/paste remains the fallback.",
      },
      {
        capability: "shell",
        status: "available",
        score: 0.9,
        reason: "Shell commands run on the host with captured exit code, stdout, and stderr under PROCESS_EXECUTE policy.",
      },
      {
        capability: "window_management",
        status: wayland ? "degraded" : "available",
        score: wayland ? 0.4 : 0.9,
        reason: wayland
          ? "Wayland compositors do not expose X11 window lists; window state comes from AT-SPI, and scrolling or pointer position may be unavailable."
          : "Windows are listed, raised, and closed through X11 window manager properties.",
      },
    ]
  }

  async info(): Promise<ComputerInfo> {
    const screen = await this.screenInfo()
    return {
      id: "linux-host",
      name: "Linux host",
      platform: "linux",
      backend: "linux-at-spi",
      connected: this.available,
      capabilities: this.capabilities(),
      metadata: {
        display: this.display ?? "none",
        ...(screen === undefined
          ? {}
          : {
              screen: {
                width: screen.width,
                height: screen.height,
                ...(screen.widthMm === undefined ? {} : { widthMm: screen.widthMm }),
                ...(screen.heightMm === undefined ? {} : { heightMm: screen.heightMm }),
                ...(screen.scale === undefined ? {} : { scale: screen.scale }),
              },
            }),
      },
    }
  }

  async executeAtspi(path: readonly number[], action: string, text?: string): Promise<ActionResult> {
    const value = text ?? ""
    if (action === "set-text" && value.length > MAX_ARG_TEXT) {
      return this.inputFailure(
        `The text is longer than the ${MAX_ARG_TEXT} character AT-SPI limit.`,
        "invalid_action",
      )
    }
    // Long text goes over stdin so it can never exceed the argv limit.
    const useStdin = action === "set-text" && value.length > 4096
    const args =
      action === "set-text"
        ? [
            "-c",
            ATSPI_SCRIPT,
            "set-text",
            "--path",
            JSON.stringify(path),
            ...(useStdin ? ["--stdin"] : ["--text", value]),
          ]
        : action === "focus"
          ? ["-c", ATSPI_SCRIPT, "focus", "--path", JSON.stringify(path)]
          : ["-c", ATSPI_SCRIPT, "act", "--path", JSON.stringify(path), "--action", action]
    const result = await this.runner(await this.resolvePython(), args, ATSPI_TIMEOUT_MS, this.env(), useStdin ? value : undefined).catch(
      (error: unknown) => {
        throw new Error(`AT-SPI action failed: ${runnerFailureReason(error)}`)
      },
    )
    try {
      const parsed: unknown = JSON.parse(result.stdout)
      if (typeof parsed === "object" && parsed !== null && (parsed as { ok?: unknown }).ok === true) {
        return { success: true, status: "success", message: `AT-SPI action ${action} completed.` }
      }
      const message =
        typeof parsed === "object" && parsed !== null && typeof (parsed as { error?: unknown }).error === "string"
          ? String((parsed as { error?: unknown }).error)
          : "AT-SPI action reported failure."
      return { success: false, status: "failed", message }
    } catch {
      return { success: false, status: "failed", message: "AT-SPI helper returned invalid output." }
    }
  }

  async readText(input: { elementId?: string; application?: string; limit?: number }): Promise<
    ActionResult & { text?: string; length?: number; hash?: string }
  > {
    const args = ["-c", ATSPI_SCRIPT, "read-text"]
    const path = input.elementId === undefined ? undefined : parseAtspiReference(input.elementId)
    if (path !== undefined) args.push("--path", JSON.stringify(path))
    else if (input.application !== undefined && input.application.length > 0) args.push("--application", input.application)
    args.push("--limit", String(Math.max(0, Math.min(input.limit ?? 200000, 200000))))
    const result = await this.runner(await this.resolvePython(), args, ATSPI_TIMEOUT_MS * 2, this.env()).catch(
      (error: unknown) => {
        throw new Error(`AT-SPI text read failed: ${runnerFailureReason(error)}`)
      },
    )
    try {
      const parsed: unknown = JSON.parse(result.stdout)
      if (typeof parsed === "object" && parsed !== null && (parsed as { ok?: unknown }).ok === true) {
        const text = typeof (parsed as { text?: unknown }).text === "string" ? String((parsed as { text: string }).text) : ""
        const length = typeof (parsed as { length?: unknown }).length === "number" ? Number((parsed as { length: number }).length) : text.length
        const hash = typeof (parsed as { hash?: unknown }).hash === "string" ? String((parsed as { hash: string }).hash) : undefined
        return {
          success: true,
          status: "success",
          message: `Read ${length} characters${hash === undefined ? "" : ` (hash ${hash})`}.`,
          text,
          length,
          ...(hash === undefined ? {} : { hash }),
        }
      }
      const message =
        typeof parsed === "object" && parsed !== null && typeof (parsed as { error?: unknown }).error === "string"
          ? String((parsed as { error?: unknown }).error)
          : "AT-SPI text read reported failure."
      return { success: false, status: "failed", message, error: { code: "read_failed", message, retryable: true } }
    } catch {
      return {
        success: false,
        status: "failed",
        message: "AT-SPI text read returned invalid output.",
        error: { code: "read_failed", message: "AT-SPI text read returned invalid output.", retryable: true },
      }
    }
  }

  async executeKey(keys: string): Promise<ActionResult> {
    const result = await this.runner(
      await this.resolvePython(),
      ["-c", ATSPI_SCRIPT, "key", "--keys", keys],
      ATSPI_TIMEOUT_MS,
      this.env(),
    ).catch((error: unknown) => {
      throw new Error(`AT-SPI key synthesis failed: ${runnerFailureReason(error)}`)
    })
    try {
      const parsed: unknown = JSON.parse(result.stdout)
      if (typeof parsed === "object" && parsed !== null && (parsed as { ok?: unknown }).ok === true) {
        return { success: true, status: "success", message: `Sent keys ${keys}.` }
      }
      return { success: false, status: "failed", message: "Key synthesis reported failure." }
    } catch {
      return { success: false, status: "failed", message: "AT-SPI helper returned invalid output." }
    }
  }

  private async xtest(
    args: readonly string[],
    timeoutMs = XTEST_TIMEOUT_MS,
  ): Promise<{ ok: boolean; error?: string } & Record<string, unknown>> {
    const result = await this.runner(
      await this.resolvePython(),
      ["-c", XTEST_SCRIPT, ...args],
      timeoutMs,
      this.env(),
    ).catch((error: unknown) => {
      throw new Error(`X11 input failed: ${runnerFailureReason(error)}`)
    })
    try {
      const parsed: unknown = JSON.parse(result.stdout)
      if (typeof parsed === "object" && parsed !== null) {
        const record = parsed as Record<string, unknown>
        if (record.ok === true) return record as { ok: boolean } & Record<string, unknown>
        return {
          ok: false,
          error: typeof record.error === "string" ? record.error : "X11 input reported failure.",
        }
      }
    } catch {
      return { ok: false, error: "X11 input helper returned invalid output." }
    }
    return { ok: false, error: "X11 input helper returned invalid output." }
  }

  private inputFailure(message: string, code: string): ActionResult {
    return { success: false, status: "failed", message, error: { code, message, retryable: false } }
  }

  async typeText(text: string): Promise<ActionResult> {
    if (text.length === 0) return { success: true, status: "success", message: "Nothing to type." }
    if (await this.waylandInput()) {
      let typed = 0
      for (const chunk of chunkText(text, TYPE_CHUNK_SIZE)) {
        const result = await this.ydotoolRun([["type", chunk]], TYPE_TIMEOUT_MS)
        if (!result.success) return result
        typed += chunk.length
      }
      return { success: true, status: "success", message: `Typed ${typed} characters.` }
    }
    await this.releaseStuckKeys()
    const skipped: string[] = []
    let typed = 0
    // Long text is sent in bounded chunks: the helper caps its run time and
    // releasing all keys between chunks guarantees no key can be left held.
    for (const chunk of chunkText(text, TYPE_CHUNK_SIZE)) {
      const result = await this.xtest(["type", "--text", chunk], TYPE_TIMEOUT_MS)
      if (!result.ok) {
        await this.releaseStuckKeys()
        return this.inputFailure(String(result.error ?? "Typing failed."), "input_failed")
      }
      typed += typeof result.typed === "number" ? result.typed : chunk.length
      if (Array.isArray(result.skipped)) skipped.push(...result.skipped.map(String))
    }
    await this.releaseStuckKeys()
    return {
      success: true,
      status: "success",
      message: `Typed ${typed} characters.`,
      ...(skipped.length === 0 ? {} : { metadata: { skipped: skipped.slice(0, 20) } }),
    }
  }

  async readClipboard(): Promise<ActionResult & { text?: string; length?: number; hash?: string }> {
    const result = await this.runner(
      await this.resolvePython(),
      ["-c", CLIPBOARD_SCRIPT, "get"],
      CLIPBOARD_TIMEOUT_MS,
      this.env(),
    ).catch((error: unknown) => ({ stdout: "", stderr: runnerFailureReason(error) }))
    try {
      const parsed: unknown = JSON.parse(result.stdout)
      if (typeof parsed === "object" && parsed !== null && (parsed as { ok?: unknown }).ok === true) {
        const text = typeof (parsed as { text?: unknown }).text === "string" ? String((parsed as { text: string }).text) : ""
        const length = typeof (parsed as { length?: unknown }).length === "number" ? Number((parsed as { length: number }).length) : text.length
        const complete = (parsed as { complete?: unknown }).complete !== false
        return {
          success: true,
          status: "success",
          message: complete
            ? `Read ${length} clipboard characters.`
            : `The clipboard owner did not respond in time; returning ${length} characters.`,
          text,
          length,
          ...(typeof (parsed as { hash?: unknown }).hash === "string" ? { hash: String((parsed as { hash: string }).hash) } : {}),
        }
      }
      const detail =
        typeof parsed === "object" && parsed !== null && typeof (parsed as { error?: unknown }).error === "string"
          ? String((parsed as { error?: unknown }).error)
          : undefined
      return this.clipboardFailure(detail)
    } catch {
      return this.clipboardFailure(result.stderr.trim().slice(0, 200) || undefined)
    }
  }

  async writeClipboardImage(path: string): Promise<ActionResult> {
    const result = await this.runner(
      await this.resolvePython(),
      ["-c", CLIPBOARD_SCRIPT, "set_image", "--path", path, "--hold", "0"],
      CLIPBOARD_TIMEOUT_MS,
      this.env(),
    ).catch((error: unknown) => ({ stdout: "", stderr: runnerFailureReason(error) }))
    try {
      const parsed: unknown = JSON.parse(result.stdout)
      if (typeof parsed === "object" && parsed !== null && (parsed as { ok?: unknown }).ok === true) {
        // Keep a short-lived owner alive so a paste works even without a
        // clipboard manager persisting the image.
        await this.spawnClipboardHolder(await this.resolvePython(), [
          "-c",
          CLIPBOARD_SCRIPT,
          "set_image",
          "--path",
          path,
          "--hold",
          "25",
        ])
        const width = (parsed as { width?: unknown }).width
        const height = (parsed as { height?: unknown }).height
        const size = typeof width === "number" && typeof height === "number" ? ` (${width}x${height})` : ""
        return { success: true, status: "success", message: `Copied the image to the clipboard${size}.` }
      }
      const detail =
        typeof parsed === "object" && parsed !== null && typeof (parsed as { error?: unknown }).error === "string"
          ? String((parsed as { error?: unknown }).error)
          : undefined
      return this.clipboardFailure(detail)
    } catch {
      return this.clipboardFailure(result.stderr.trim().slice(0, 200) || undefined)
    }
  }

  async writeClipboard(text: string): Promise<ActionResult> {
    const python = await this.resolvePython()
    // Clipboard text is unbounded, so it is passed over stdin rather than
    // argv; the helper reads it when --stdin is present.
    const result = await this.runner(
      python,
      ["-c", CLIPBOARD_SCRIPT, "set", "--stdin", "--hold", "0"],
      CLIPBOARD_TIMEOUT_MS,
      this.env(),
      text,
    ).catch((error: unknown) => ({ stdout: "", stderr: runnerFailureReason(error) }))
    try {
      const parsed: unknown = JSON.parse(result.stdout)
      if (typeof parsed === "object" && parsed !== null && (parsed as { ok?: unknown }).ok === true) {
        // Keep a short-lived owner alive in the background so a paste works
        // even when the desktop has no clipboard manager to persist content.
        await this.spawnClipboardHolder(python, ["-c", CLIPBOARD_SCRIPT, "set", "--stdin", "--hold", "25"], text)
        return { success: true, status: "success", message: `Wrote ${text.length} characters to the clipboard.` }
      }
      const detail =
        typeof parsed === "object" && parsed !== null && typeof (parsed as { error?: unknown }).error === "string"
          ? String((parsed as { error?: unknown }).error)
          : undefined
      return this.clipboardFailure(detail)
    } catch {
      return this.clipboardFailure(result.stderr.trim().slice(0, 200) || undefined)
    }
  }

  private clipboardFailure(detail: string | undefined): ActionResult {
    const message =
      detail === undefined || detail.length === 0
        ? "The clipboard backend did not respond on this computer."
        : `The clipboard backend failed: ${detail}`
    return {
      success: false,
      status: "unavailable",
      message,
      error: { code: "operation_unavailable", message, retryable: true },
    }
  }

  async releaseStuckKeys(): Promise<ActionResult> {
    if (await this.waylandInput()) {
      const result = await this.ydotoolRun([ydotoolReleaseArgs()])
      if (!result.success) return result
      return { success: true, status: "success", message: "Released any held keys." }
    }
    const result = await this.xtest(["release"]).catch(() => ({ ok: false as const }))
    if (!result.ok) return this.inputFailure("Could not reset keyboard state.", "input_failed")
    return { success: true, status: "success", message: "Released any held keys." }
  }

  async sendGlobalKey(keys: string): Promise<ActionResult> {
    if (await this.waylandInput()) {
      const sequence = ydotoolKeySequence(keys)
      if (sequence === undefined) {
        return this.inputFailure(`The key ${keys} is not supported by the Wayland input backend.`, "input_failed")
      }
      const result = await this.ydotoolRun(sequence)
      if (!result.success) return result
      return { success: true, status: "success", message: `Sent keys ${keys}.` }
    }
    const result = await this.xtest(["key", "--keys", keys])
    if (!result.ok) {
      await this.releaseStuckKeys()
      const fallback = await this.executeKey(keys).catch(() => undefined)
      if (fallback?.success) return fallback
      return this.inputFailure(String(result.error ?? `Could not send ${keys}.`), "input_failed")
    }
    return { success: true, status: "success", message: `Sent keys ${keys}.` }
  }

  async clickAt(x: number, y: number, button = 1, count = 1, durationMs = 220): Promise<ActionResult> {
    if (await this.waylandInput()) {
      const codes = ydotoolButtonCodes(button)
      const sequence: string[][] = [ydotoolMoveArgs(x, y)]
      for (let index = 0; index < Math.max(1, count); index += 1) {
        sequence.push(["click", String(codes.down)], ["click", String(codes.up)])
      }
      const result = await this.ydotoolRun(sequence)
      if (!result.success) return result
      return {
        success: true,
        status: "success",
        message: `Clicked at ${Math.round(x)},${Math.round(y)}.`,
        metadata: { x: Math.round(x), y: Math.round(y), backend: "ydotool" },
      }
    }
    const result = await this.xtest([
      "click",
      "--x",
      String(Math.round(x)),
      "--y",
      String(Math.round(y)),
      "--button",
      String(button),
      "--count",
      String(count),
      "--duration",
      String(Math.max(0, Math.round(durationMs))),
    ])
    if (!result.ok) return this.inputFailure(String(result.error ?? "Pointer click failed."), "input_failed")
    const actual = await this.pointerPosition().catch(() => undefined)
    return {
      success: true,
      status: "success",
      message: `Clicked at ${Math.round(x)},${Math.round(y)}.`,
      metadata: {
        x: Math.round(x),
        y: Math.round(y),
        ...(actual?.x === undefined ? {} : { actualX: actual.x }),
        ...(actual?.y === undefined ? {} : { actualY: actual.y }),
      },
    }
  }

  async movePointer(x: number, y: number, durationMs = 220): Promise<ActionResult> {
    if (await this.waylandInput()) {
      const result = await this.ydotoolRun([ydotoolMoveArgs(x, y)])
      if (!result.success) return result
      return {
        success: true,
        status: "success",
        message: `Moved the pointer to ${Math.round(x)},${Math.round(y)}.`,
        metadata: { x: Math.round(x), y: Math.round(y), backend: "ydotool" },
      }
    }
    const result = await this.xtest([
      "move",
      "--x",
      String(Math.round(x)),
      "--y",
      String(Math.round(y)),
      "--duration",
      String(Math.max(0, Math.round(durationMs))),
    ])
    if (!result.ok) return this.inputFailure(String(result.error ?? "Pointer move failed."), "input_failed")
    return {
      success: true,
      status: "success",
      message: `Moved the pointer to ${Math.round(x)},${Math.round(y)}.`,
      metadata: { x: Math.round(x), y: Math.round(y), durationMs: Math.round(durationMs) },
    }
  }

  async pointerPosition(): Promise<ActionResult & { x?: number; y?: number; held?: boolean }> {
    if (await this.waylandInput()) {
      return this.inputFailure(
        "Reading the pointer position needs an X11 session; Wayland compositors do not expose it.",
        "operation_unavailable",
      )
    }
    const result = await this.xtest(["position"])
    if (!result.ok) return this.inputFailure(String(result.error ?? "Could not read the pointer."), "input_failed")
    const x = typeof result.x === "number" ? result.x : undefined
    const y = typeof result.y === "number" ? result.y : undefined
    return {
      success: true,
      status: "success",
      message: `The pointer is at ${x ?? "?"},${y ?? "?"}${result.held === true ? " with a button held" : ""}.`,
      ...(x === undefined ? {} : { x }),
      ...(y === undefined ? {} : { y }),
      held: result.held === true,
    }
  }

  async pointerWindow(): Promise<{ window: string } | undefined> {
    if (await this.waylandInput()) return undefined
    const result = await this.xtest(["pointer-window"]).catch(() => undefined)
    if (result === undefined || !result.ok) return undefined
    const window = typeof result.window === "string" && /^0x[0-9a-f]+$/i.test(result.window) ? result.window : undefined
    return window === undefined || window === "0x0" ? undefined : { window }
  }

  subscribeInputGrab(listener: (event: InputGrabEvent) => void): () => void {
    this.grabListeners.add(listener)
    return () => {
      this.grabListeners.delete(listener)
    }
  }

  async grabInput(reason?: string): Promise<ActionResult & { frozen?: boolean; supported?: boolean; mode?: string }> {
    if (!this.available) {
      return {
        success: false,
        status: "unavailable",
        message: "Freezing physical input requires a Linux X11 display.",
        supported: false,
        mode: "x11",
        error: {
          code: "operation_unavailable",
          message: "Freezing physical input requires a Linux X11 display.",
          retryable: false,
        },
      }
    }
    if (this.grabSession?.frozen === true) {
      return { success: true, status: "success", message: "Physical input is already frozen.", frozen: true, supported: true, mode: "x11" }
    }
    if (this.grabSession !== undefined) await this.releaseInput().catch(() => undefined)
    const session = createGrabSession(
      spawn(await this.resolvePython(), ["-c", INPUT_GRAB_SCRIPT], { env: { ...process.env, ...this.env() } }),
      reason,
    )
    this.grabSession = session
    session.child.stdout.setEncoding("utf8")
    session.child.stdout.on("data", (chunk: string) => this.handleGrabOutput(session, chunk))
    session.child.stderr.setEncoding("utf8")
    session.child.stderr.on("data", (chunk: string) => {
      session.stderr = (session.stderr + chunk).slice(-500)
    })
    session.child.on("error", (error) => {
      if (session.settled) return
      session.settled = true
      session.resolveReady({ ok: false, error: error.message })
    })
    session.child.on("exit", (code) => this.handleGrabExit(session, code))
    const outcome = await Promise.race([
      session.ready,
      new Promise<{ ok: false; error: string }>((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, error: "The input grab helper timed out." }), INPUT_GRAB_TIMEOUT_MS)
        timer.unref?.()
      }),
    ])
    if (!outcome.ok) {
      if (this.grabSession === session) this.grabSession = undefined
      session.settled = true
      // SIGTERM alone can leave the X grab held; escalate and wait for exit.
      session.child.kill("SIGTERM")
      const killTimer = setTimeout(() => session.child.kill("SIGKILL"), 1000)
      await childExited(session.child)
      clearTimeout(killTimer)
      const detail = session.stderr.trim()
      const message = detail.length === 0 ? outcome.error : `${outcome.error} ${detail}`
      return {
        success: false,
        status: "unavailable",
        message,
        supported: true,
        mode: "x11",
        error: { code: "operation_unavailable", message, retryable: false },
      }
    }
    return {
      success: true,
      status: "success",
      message: reason === undefined ? "Physical input is frozen." : `Physical input is frozen: ${reason}.`,
      frozen: true,
      supported: true,
      mode: "x11",
    }
  }

  async releaseInput(): Promise<
    ActionResult & { frozen?: boolean; releasedBy?: InputGrabReleasedBy; supported?: boolean; mode?: string }
  > {
    const session = this.grabSession
    if (session === undefined) {
      return {
        success: true,
        status: "success",
        message: "Physical input is not frozen.",
        frozen: false,
        supported: this.available,
        releasedBy: this.lastGrabReleasedBy ?? "request",
      }
    }
    session.requested = true
    const exited = childExited(session.child)
    session.child.kill("SIGTERM")
    const timer = setTimeout(() => session.child.kill("SIGKILL"), INPUT_GRAB_RELEASE_TIMEOUT_MS)
    await exited
    clearTimeout(timer)
    if (this.grabSession === session) this.handleGrabExit(session, session.child.exitCode)
    return {
      success: true,
      status: "success",
      message: "Released the physical input grab.",
      frozen: false,
      supported: true,
      mode: "x11",
      releasedBy: session.releasedBy === "escape" ? "escape" : "request",
    }
  }

  async inputGrabState(): Promise<
    ActionResult & { frozen?: boolean; supported?: boolean; reason?: string; releasedBy?: InputGrabReleasedBy }
  > {
    const session = this.grabSession
    return {
      success: true,
      status: "success",
      message: session?.frozen === true ? "Physical input is frozen." : "Physical input is not frozen.",
      frozen: session?.frozen === true,
      supported: this.available,
      ...(session?.reason === undefined ? {} : { reason: session.reason }),
      ...(session === undefined && this.lastGrabReleasedBy !== undefined ? { releasedBy: this.lastGrabReleasedBy } : {}),
    }
  }

  dispose(): void {
    this.disposed = true
    const session = this.grabSession
    this.grabSession = undefined
    if (session !== undefined) {
      session.requested = true
      // Emit the released event before the kill so subscribers never see a
      // stale "frozen" state after dispose.
      this.finishGrab(session)
      session.child.kill("SIGKILL")
    }
    const pending = this.atspiHelperPending
    this.atspiHelperPending = undefined
    void (async () => {
      const helper =
        this.atspiHelper ?? (pending === undefined ? undefined : await pending.catch(() => undefined))
      this.atspiHelper = undefined
      if (this.injectedAtspiHelper === undefined && helper !== undefined) {
        await helper.dispose().catch(() => undefined)
      }
    })()
  }

  private notifyGrab(event: InputGrabEvent): void {
    for (const listener of this.grabListeners) {
      try {
        listener(event)
      } catch {
        // One throwing subscriber must not break the others or the caller.
      }
    }
  }

  private finishGrab(session: GrabSession): void {
    if (!session.frozen || session.notified) return
    session.notified = true
    // An explicit release is "request" even though the helper reports the
    // SIGTERM it received; "signal" is reserved for external terminations.
    const releasedBy = session.requested
      ? "request"
      : session.releasedBy === "escape"
        ? "escape"
        : (session.releasedBy ?? "signal")
    this.lastGrabReleasedBy = releasedBy
    this.notifyGrab({
      type: "released",
      releasedBy,
      ...(session.reason === undefined ? {} : { reason: session.reason }),
    })
  }

  private handleGrabOutput(session: GrabSession, chunk: string): void {
    session.buffer += chunk
    const lines = session.buffer.split("\n")
    session.buffer = lines.pop() ?? ""
    for (const line of lines) {
      const parsed = parseInputGrabLine(line.trim())
      if (parsed === undefined) continue
      if (parsed.event === "frozen" && !session.settled) {
        session.settled = true
        session.frozen = true
        session.resolveReady({ ok: true })
        this.notifyGrab({
          type: "frozen",
          ...(session.reason === undefined ? {} : { reason: session.reason }),
        })
        continue
      }
      if (parsed.event === "released") {
        session.releasedBy = parsed.reason === "escape" ? "escape" : "signal"
        this.finishGrab(session)
        continue
      }
      if (parsed.event === "error" && !session.settled) {
        session.settled = true
        session.resolveReady({ ok: false, error: parsed.error ?? parsed.status ?? "The input grab failed." })
      }
    }
  }

  private handleGrabExit(session: GrabSession, code: number | null): void {
    if (!session.settled) {
      session.settled = true
      session.resolveReady({ ok: false, error: `The input grab helper exited (code ${code ?? "unknown"}).` })
    }
    this.finishGrab(session)
    if (this.grabSession === session) this.grabSession = undefined
  }

  async mouseDown(button = 1): Promise<ActionResult> {
    if (await this.waylandInput()) {
      const result = await this.ydotoolRun([["click", String(ydotoolButtonCodes(button).down)]])
      if (!result.success) return result
      return { success: true, status: "success", message: `Held mouse button ${button}.` }
    }
    const result = await this.xtest(["down", "--button", String(button)])
    if (!result.ok) return this.inputFailure(String(result.error ?? "Pointer press failed."), "input_failed")
    return { success: true, status: "success", message: `Held mouse button ${button}.` }
  }

  async mouseUp(button = 1): Promise<ActionResult> {
    if (await this.waylandInput()) {
      const result = await this.ydotoolRun([["click", String(ydotoolButtonCodes(button).up)]])
      if (!result.success) return result
      return { success: true, status: "success", message: `Released mouse button ${button}.` }
    }
    const result = await this.xtest(["up", "--button", String(button)])
    if (!result.ok) return this.inputFailure(String(result.error ?? "Pointer release failed."), "input_failed")
    return { success: true, status: "success", message: `Released mouse button ${button}.` }
  }

  async hoverPointer(x: number, y: number, holdMs = 600): Promise<ActionResult> {
    const moved = await this.movePointer(x, y)
    if (!moved.success) return moved
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(holdMs, 5000))))
    return {
      success: true,
      status: "success",
      message: `Hovered at ${Math.round(x)},${Math.round(y)} for ${Math.round(holdMs)}ms.`,
    }
  }

  async scrollPointer(
    direction: string,
    amount: number,
    x?: number,
    y?: number,
    durationMs = 200,
  ): Promise<ActionResult> {
    if (await this.waylandInput()) {
      return this.inputFailure(
        "Scrolling is not supported by the Wayland input backend; use keyboard scrolling instead.",
        "operation_unavailable",
      )
    }
    const result = await this.xtest([
      "scroll",
      "--direction",
      direction,
      "--amount",
      String(Math.max(1, Math.round(amount))),
      "--duration",
      String(Math.max(0, Math.round(durationMs))),
      ...(x === undefined || y === undefined ? [] : ["--x", String(Math.round(x)), "--y", String(Math.round(y))]),
    ])
    if (!result.ok) return this.inputFailure(String(result.error ?? "Pointer scroll failed."), "input_failed")
    return { success: true, status: "success", message: `Scrolled ${direction}.` }
  }

  async dragPointer(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    button = 1,
    durationMs = 600,
  ): Promise<ActionResult> {
    if (await this.waylandInput()) {
      const codes = ydotoolButtonCodes(button)
      const steps = 10
      const sequence: string[][] = [ydotoolMoveArgs(fromX, fromY), ["click", String(codes.down)]]
      for (let step = 1; step <= steps; step += 1) {
        sequence.push(ydotoolMoveArgs(fromX + ((toX - fromX) * step) / steps, fromY + ((toY - fromY) * step) / steps))
      }
      sequence.push(["click", String(codes.up)])
      const result = await this.ydotoolRun(sequence)
      if (!result.success) return result
      return {
        success: true,
        status: "success",
        message: `Dragged from ${Math.round(fromX)},${Math.round(fromY)} to ${Math.round(toX)},${Math.round(toY)}.`,
      }
    }
    const result = await this.xtest([
      "drag",
      "--from-x",
      String(Math.round(fromX)),
      "--from-y",
      String(Math.round(fromY)),
      "--to-x",
      String(Math.round(toX)),
      "--to-y",
      String(Math.round(toY)),
      "--button",
      String(button),
      "--duration",
      String(Math.max(120, Math.round(durationMs))),
    ])
    if (!result.ok) return this.inputFailure(String(result.error ?? "Pointer drag failed."), "input_failed")
    return {
      success: true,
      status: "success",
      message: `Dragged from ${Math.round(fromX)},${Math.round(fromY)} to ${Math.round(toX)},${Math.round(toY)}.`,
    }
  }

  async activateWindowId(windowId: string): Promise<ActionResult> {
    const result = await this.xtest(["activate", "--window", windowId])
    if (!result.ok) return this.inputFailure(String(result.error ?? "Window activation failed."), "input_failed")
    return { success: true, status: "success", message: `Activated window ${windowId}.` }
  }

  async closeWindowId(windowId: string): Promise<ActionResult> {
    const result = await this.xtest(["close", "--window", windowId])
    if (!result.ok) return this.inputFailure(String(result.error ?? "Window close failed."), "input_failed")
    return { success: true, status: "success", message: `Asked window ${windowId} to close.` }
  }

  async minimizeWindowId(windowId: string): Promise<ActionResult> {
    const result = await this.xtest(["minimize-window", "--window", windowId])
    if (!result.ok) return this.inputFailure(String(result.error ?? "Window minimize failed."), "input_failed")
    return { success: true, status: "success", message: `Minimized window ${windowId}.` }
  }

  async maximizeWindowId(windowId: string, restore = false): Promise<ActionResult> {
    const result = await this.xtest(["maximize-window", "--window", windowId, ...(restore ? ["--unmaximize"] : [])])
    if (!result.ok) return this.inputFailure(String(result.error ?? "Window maximize failed."), "input_failed")
    return { success: true, status: "success", message: `${restore ? "Unmaximized" : "Maximized"} window ${windowId}.` }
  }

  async tileWindowId(
    windowId: string,
    position: string,
  ): Promise<ActionResult & { x?: number; y?: number; width?: number; height?: number }> {
    const result = await this.xtest(["tile-window", "--window", windowId, "--position", position])
    if (!result.ok) {
      return this.inputFailure(String(result.error ?? `Unknown tile position ${position}.`), "input_failed")
    }
    return {
      success: true,
      status: "success",
      message: `Tiled window ${windowId} to ${position} (${result.x},${result.y} ${result.width}x${result.height}).`,
      ...(typeof result.x === "number" ? { x: result.x } : {}),
      ...(typeof result.y === "number" ? { y: result.y } : {}),
      ...(typeof result.width === "number" ? { width: result.width } : {}),
      ...(typeof result.height === "number" ? { height: result.height } : {}),
    }
  }

  async moveWindowId(
    windowId: string,
    rect: { x?: number; y?: number; width?: number; height?: number },
  ): Promise<ActionResult> {
    const args = ["move-window", "--window", windowId]
    if (rect.x !== undefined) args.push("--x", String(rect.x))
    if (rect.y !== undefined) args.push("--y", String(rect.y))
    if (rect.width !== undefined) args.push("--width", String(rect.width))
    if (rect.height !== undefined) args.push("--height", String(rect.height))
    const result = await this.xtest(args)
    if (!result.ok) return this.inputFailure(String(result.error ?? "Window move failed."), "input_failed")
    return { success: true, status: "success", message: `Moved window ${windowId}.` }
  }

  async restoreWindowId(windowId: string): Promise<ActionResult> {
    const result = await this.xtest(["restore-window", "--window", windowId])
    if (!result.ok) return this.inputFailure(String(result.error ?? "Window restore failed."), "input_failed")
    return { success: true, status: "success", message: `Restored window ${windowId}.` }
  }

  async launchApp(app: string): Promise<ActionResult> {
    const tokens = splitCommand(app)
    const command = tokens[0]
    if (command === undefined || command.length === 0) {
      return this.inputFailure("A launch action requires an application.", "invalid_action")
    }
    const args = tokens.slice(1)
    const base = basename(command).toLowerCase()
    // LibreOffice reopens recovery dialogs and needs its accessibility bridge
    // enabled explicitly; the runtime also connects through its UNO socket.
    if ((base === "soffice" || base === "libreoffice" || base.startsWith("libreoffice")) && !args.some((arg) => arg.startsWith("--norestore"))) {
      args.push("--norestore")
    }
    const launched = await this.spawnDetached(command, args)
    if (!launched.ok) {
      if (base === "soffice" || base === "libreoffice" || base.startsWith("libreoffice")) {
        const flatpak = await this.spawnDetached("flatpak", ["run", "org.libreoffice.LibreOffice", ...args])
        if (flatpak.ok) {
          return {
            success: true,
            status: "success",
            message: `Launched LibreOffice through Flatpak with accessibility enabled.`,
            metadata: {
              application: "org.libreoffice.LibreOffice",
              arguments: args,
              backend: "flatpak",
              launchVerified: false,
              warning: "Flatpak spawn only proves the launcher started; the application window was not verified.",
            },
          }
        }
        return this.inputFailure(flatpak.error ?? "Could not launch LibreOffice.", "launch_failed")
      }
      return this.inputFailure(launched.error ?? `Could not launch ${command}.`, "launch_failed")
    }
    return {
      success: true,
      status: "success",
      message: `Launched ${app} with accessibility enabled.`,
      metadata: { application: command, arguments: tokens.slice(1), backend: "process" },
    }
  }

  async openTarget(target: string): Promise<ActionResult> {
    const value = target.trim()
    if (value.length === 0) return this.inputFailure("An open action requires a path or URL.", "invalid_action")
    // A missing file must fail loudly; xdg-open exits non-zero and the agent
    // would otherwise see a false success and wait for a window that never comes.
    const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    if (!isUrl && !existsSync(value)) {
      return this.inputFailure(`No such file or directory: ${value}`, "file_not_found")
    }
    // Office documents need the accessibility environment; an already-running
    // LibreOffice would otherwise keep its a11y bridge disabled.
    const office = !isUrl && /\.(ods|odt|odp|odg|docx?|xlsx?|pptx?|csv)$/i.test(value)
    const launched = office
      ? await this.spawnDetached("soffice", ["--norestore", value])
      : await this.spawnDetached("xdg-open", [value])
    if (!launched.ok) return this.inputFailure(launched.error ?? `Could not open ${value}.`, "open_failed")
    return {
      success: true,
      status: "success",
      message: `Opened ${value}.`,
      metadata: { target: value, backend: office ? "soffice" : "process" },
    }
  }

  async captureScreen(): Promise<ActionResult & { path?: string }> {
    // The PNG is the user's screen: it must not be readable by other local
    // accounts. A predictable `tmpdir()/omnia-screenshot-<Date.now()>.png` is
    // world-writable and name-guessable, so capture into a directory mkdtemp
    // created 0700 and delete it as soon as the capture is read back.
    const directory = mkdtempSync(join(tmpdir(), "omnia-screenshot-"))
    try {
      const file = join(directory, "screenshot.png")
      // The capture tools (grim, spectacle -o, ffmpeg -y) create their output
      // 0644 and follow symlinks, so the destination already exists owner-only
      // before they run and can only be overwritten in place.
      const placeholder = openSync(file, "wx", 0o600)
      closeSync(placeholder)
      return await this.captureScreenTo(file)
    } finally {
      // A capture that throws must not leave the user's screen in the tmp root.
      rmSync(directory, { force: true, recursive: true })
    }
  }

  private async captureScreenTo(file: string): Promise<ActionResult & { path?: string }> {
    const size = await this.screenSize()
    const candidates: Array<{ file: string; args: string[] }> = [
      { file: "spectacle", args: ["-b", "-n", "-o", file] },
      { file: "grim", args: [file] },
      ...(size === undefined || this.display === undefined
        ? []
        : [
            {
              file: "ffmpeg",
              args: [
                "-loglevel",
                "error",
                "-f",
                "x11grab",
                "-video_size",
                `${size.width}x${size.height}`,
                "-i",
                this.display,
                "-frames:v",
                "1",
                "-y",
                file,
              ],
            },
          ]),
    ]
    for (const candidate of candidates) {
      const ran = await this.runner(candidate.file, candidate.args, CAPTURE_TIMEOUT_MS, this.env())
        .then(() => true)
        .catch(() => false)
      if (!ran) continue
      const captured = await stat(file).catch(() => undefined)
      if (captured === undefined || captured.size === 0) continue
      // A backend that replaced the file instead of truncating it resets the
      // mode to its own 0644 default.
      chmodSync(file, 0o600)
      this.captureStatus = "available"
      await this.pruneScreenshots()
      return {
        success: true,
        status: "success",
        message: `Captured the screen to ${file}.`,
        metadata: { path: file, backend: candidate.file, bytes: captured.size },
        path: file,
      }
    }
    this.captureStatus = "unavailable"
    return {
      success: false,
      status: "unavailable",
      message: "No screen capture backend is available on this computer.",
      error: {
        code: "operation_unavailable",
        message: "Install spectacle or ffmpeg to enable screen capture.",
        retryable: false,
      },
    }
  }

  async screenInfo(): Promise<ScreenInfo | undefined> {
    if (!this.available) return undefined
    // On Wayland xrandr usually fails (XWayland only); screen geometry then
    // falls back to xwininfo, which reports the XWayland root, not the full
    // compositor output set. wlr-randr support is still missing.
    const env = this.env()
    const monitors = await this.runner("xrandr", ["--listmonitors"], XPROP_TIMEOUT_MS, env).catch(() => undefined)
    const virtual = monitors === undefined ? undefined : parseXrandrMonitors(monitors.stdout)
    const xrandr = await this.runner("xrandr", [], XPROP_TIMEOUT_MS, env).catch(() => undefined)
    const size =
      virtual ??
      (xrandr === undefined ? undefined : parseXrandr(xrandr.stdout)) ??
      (await this.screenSize())
    if (size === undefined) return undefined
    const xdpyinfo = await this.runner("xdpyinfo", [], XPROP_TIMEOUT_MS, env).catch(() => undefined)
    const mm = xdpyinfo === undefined ? undefined : parseXdpyinfo(xdpyinfo.stdout)
    const geometry = {
      width: size.width,
      height: size.height,
      ...(virtual === undefined ? {} : { x: virtual.x, y: virtual.y }),
    }
    if (mm === undefined) return geometry
    const scale = Math.round((size.width / (mm.widthMm / 25.4) / 96) * 100) / 100
    return { ...geometry, widthMm: mm.widthMm, heightMm: mm.heightMm, scale }
  }

  private async pruneScreenshots(): Promise<void> {
    const entries = await readdir(tmpdir()).catch(() => undefined)
    if (entries === undefined) return
    const cutoff = Date.now() - 60 * 60 * 1000
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith("omnia-screenshot-") && entry.endsWith(".png"))
        .map(async (entry) => {
          const path = join(tmpdir(), entry)
          const info = await stat(path).catch(() => undefined)
          if (info !== undefined && info.mtimeMs < cutoff) await unlink(path).catch(() => undefined)
        }),
    )
  }

  private async screenSize(): Promise<{ width: number; height: number } | undefined> {
    const result = await this.runner("xwininfo", ["-root"], XPROP_TIMEOUT_MS, this.env()).catch(() => undefined)
    if (!result) return undefined
    const width = Number(result.stdout.match(/Width:\s*(\d+)/)?.[1])
    const height = Number(result.stdout.match(/Height:\s*(\d+)/)?.[1])
    if (!Number.isFinite(width) || !Number.isFinite(height) || width === 0 || height === 0) return undefined
    return { width, height }
  }

  async runCommand(
    request: CommandRequest,
  ): Promise<ActionResult & { command?: CommandResult & { stdinError?: string } }> {
    const timeoutMs = Math.max(1000, Math.min(request.timeoutMs ?? 120000, 600000))
    const maxOutputBytes = Math.max(4096, Math.min(request.maxOutputBytes ?? 262144, 1024 * 1024))
    const startedAt = Date.now()
    // Shell interpretation is opt-in by shape, not by default: a command with
    // no shell metacharacters runs argv-style so agent text is never
    // re-interpreted by /bin/sh. The PROCESS_EXECUTE policy barrier still
    // gates every command before this driver is called; this boundary is
    // about interpretation only.
    const tokens = splitCommand(request.command)
    const command = tokens[0]
    if (command === undefined || command.length === 0 || request.command.includes("\0")) {
      return {
        success: false,
        status: "failed",
        message: "The command is empty or contains invalid characters.",
        error: {
          code: "invalid_command",
          message: "The command is empty or contains invalid characters.",
          retryable: false,
        },
      }
    }
    const useShell = commandRequiresShell(request.command)
    if (request.cwd !== undefined && request.cwd.length > 0) {
      if (!existsSync(request.cwd) || !statSync(request.cwd).isDirectory()) {
        return {
          success: false,
          status: "failed",
          message: `The working directory does not exist: ${request.cwd}`,
          error: { code: "invalid_cwd", message: `The working directory does not exist: ${request.cwd}`, retryable: false },
        }
      }
    }
    // A command must not be able to replace the display or the loader
    // environment the runtime depends on; DISPLAY always comes from the driver.
    const forbidden = new Set(["PATH", "DISPLAY", "LD_PRELOAD", "LD_LIBRARY_PATH", "NODE_OPTIONS"])
    const unsafe = Object.keys(request.env ?? {}).find((key) => forbidden.has(key.toUpperCase()))
    if (unsafe !== undefined) {
      return {
        success: false,
        status: "failed",
        message: `The command environment cannot override ${unsafe}.`,
        error: {
          code: "invalid_env",
          message: `The command environment cannot override ${unsafe}.`,
          retryable: false,
        },
      }
    }
    return new Promise((resolve) => {
      const child = useShell
        ? spawn(request.command, {
            shell: true,
            cwd: request.cwd,
            env: {
              ...process.env,
              ...(request.env ?? {}),
              ...(this.display === undefined ? {} : { DISPLAY: this.display }),
            },
            stdio: ["pipe", "pipe", "pipe"],
          })
        : spawn(command, tokens.slice(1), {
            shell: false,
            cwd: request.cwd,
            env: {
              ...process.env,
              ...(request.env ?? {}),
              ...(this.display === undefined ? {} : { DISPLAY: this.display }),
            },
            stdio: ["pipe", "pipe", "pipe"],
          })
      let stdout = ""
      let stderr = ""
      let truncated = false
      let timedOut = false
      let settled = false
      let stdinError: string | undefined
      let killTimer: ReturnType<typeof setTimeout> | undefined
      const append = (current: string, chunk: Buffer): string => {
        if (current.length >= maxOutputBytes) {
          truncated = true
          return current
        }
        const next = current + chunk.toString("utf8")
        if (next.length > maxOutputBytes) {
          truncated = true
          return next.slice(0, maxOutputBytes)
        }
        return next
      }
      child.stdout.on("data", (chunk: Buffer) => {
        stdout = append(stdout, chunk)
      })
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = append(stderr, chunk)
      })
      const timer = setTimeout(() => {
        timedOut = true
        child.kill("SIGTERM")
        // The escalation must survive until the kill lands; clearing it on
        // close prevents a stray SIGKILL against a reused pid.
        killTimer = setTimeout(() => child.kill("SIGKILL"), 2000)
      }, timeoutMs)
      timer.unref?.()
      const finish = (exitCode: number | null, error?: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (killTimer !== undefined) clearTimeout(killTimer)
        const result: CommandResult & { stdinError?: string } = {
          exitCode,
          stdout,
          stderr,
          truncated,
          timedOut,
          durationMs: Date.now() - startedAt,
          ...(stdinError === undefined ? {} : { stdinError }),
        }
        const success = error === undefined && !timedOut && exitCode === 0
        resolve({
          success,
          status: success ? "success" : "failed",
          message:
            error ??
            (timedOut ? `Command timed out after ${timeoutMs}ms.` : `Command exited with code ${exitCode ?? "unknown"}.`),
          command: result,
          ...(error === undefined ? {} : { error: { code: "command_failed", message: error, retryable: false } }),
        })
      }
      child.once("error", (error) => finish(null, error.message))
      child.once("close", (code) => finish(code))
      // A command that exits before reading stdin must not crash the daemon
      // with an unhandled EPIPE; the error is recorded in CommandResult so a
      // swallowed write is visible to callers.
      child.stdin.on("error", (error: Error) => {
        stdinError = stdinError ?? error.message
      })
      if (request.stdin !== undefined) child.stdin.write(request.stdin)
      child.stdin.end()
    })
  }

  private spawnDetached(
    command: string,
    args: readonly string[] = [],
    input?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    // spawn() throws synchronously on a NUL byte in the command or arguments,
    // which would escape as a rejected promise instead of a failed ActionResult
    // for launch and open requests carrying agent-supplied text.
    if ([command, ...args].some((value) => value.includes("\0"))) {
      return Promise.resolve({ ok: false, error: "The command contains invalid characters." })
    }
    return new Promise((resolve) => {
      const child = spawn(command, [...args], {
        detached: true,
        stdio: input === undefined ? "ignore" : ["pipe", "ignore", "ignore"],
        env: {
          ...process.env,
          ...(this.display === undefined ? {} : { DISPLAY: this.display }),
          QT_ACCESSIBILITY: "1",
          ACCESSIBILITY_ENABLED: "1",
          SAL_USE_VCLPLUGIN: "gtk3",
          NO_AT_BRIDGE: "0",
          GTK_MODULES: "gail:atk-bridge",
        },
      })
      if (input !== undefined) {
        child.stdin?.on("error", () => undefined)
        child.stdin?.end(input)
      }
      child.once("error", (error) => resolve({ ok: false, error: error.message }))
      child.once("spawn", () => {
        child.unref()
        resolve({ ok: true })
      })
    })
  }

  // Detached clipboard owners hold the selection for ~25s. They are tracked so
  // a burst of writes cannot accumulate an unbounded number of processes.
  private async spawnClipboardHolder(
    command: string,
    args: readonly string[],
    input?: string,
  ): Promise<void> {
    while (this.clipboardHolders.size >= 4) {
      const oldest = this.clipboardHolders.values().next().value
      if (oldest === undefined) break
      this.clipboardHolders.delete(oldest)
      oldest.kill("SIGTERM")
    }
    const child = spawn(command, [...args], {
      detached: true,
      stdio: input === undefined ? "ignore" : ["pipe", "ignore", "ignore"],
      env: {
        ...process.env,
        ...(this.display === undefined ? {} : { DISPLAY: this.display }),
      },
    })
    this.clipboardHolders.add(child)
    child.once("exit", () => {
      this.clipboardHolders.delete(child)
    })
    if (input !== undefined) {
      child.stdin?.on("error", () => undefined)
      child.stdin?.end(input)
    }
    child.unref()
  }
}

export function capabilityState(capabilities: readonly CapabilitySupport[], name: string): CapabilityState {
  return capabilities.find((capability) => capability.capability === name)?.status ?? "unknown"
}
