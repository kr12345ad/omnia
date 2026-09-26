import { execFile, spawn } from "node:child_process"
import { stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import type {
  ActionResult,
  CapabilityState,
  CapabilitySupport,
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
import { XTEST_SCRIPT } from "./xtest-script"

export type RunResult = { stdout: string; stderr: string }
export type Runner = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
  env?: Record<string, string>,
) => Promise<RunResult>

export const OBSERVATION_TTL_MS = 350
export const XPROP_TIMEOUT_MS = 5000
export const ATSPI_TIMEOUT_MS = 15000
export const XTEST_TIMEOUT_MS = 15000
export const TYPE_TIMEOUT_MS = 20000
export const TYPE_CHUNK_SIZE = 400
export const CAPTURE_TIMEOUT_MS = 20000
export const CLIPBOARD_TIMEOUT_MS = 20000
export const MAX_ELEMENT_TEXT = 500

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
): Promise<RunResult> {
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

function runnerFailureReason(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined
  return code === "ETIMEDOUT" ? "timed out" : "helper process failed"
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
  const strings = (value: string) =>
    value
      .split(/"\s*,\s*"/)
      .map((item) => item.replace(/^"/, "").replace(/"$/, "").replaceAll('\\"', '"'))
  const cls = strings(rawValue("WM_CLASS"))
  const pidMatch = output.match(/_NET_WM_PID\(CARDINAL\)\s*=\s*(\d+)/)
  return {
    instance: cls[0] ?? "",
    cls: cls[1] ?? cls[0] ?? "",
    title: strings(rawValue("WM_NAME"))[0] ?? strings(rawValue("_NET_WM_NAME"))[0] ?? "",
    ...(pidMatch?.[1] === undefined ? {} : { pid: Number(pidMatch[1]) }),
  }
}

export function parseXwininfo(output: string): { x: number; y: number; width: number; height: number } {
  const num = (key: string) => {
    const match = output.match(new RegExp(`${key}:\\s*(-?\\d+)`))
    return match?.[1] === undefined ? 0 : Number(match[1])
  }
  return { x: num("Absolute upper-left X"), y: num("Absolute upper-left Y"), width: num("Width"), height: num("Height") }
}

export function parseXrandr(output: string): { width: number; height: number } | undefined {
  const match = output.match(/^\s*\S+\s+connected\b[^\n]*?(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/m)
  if (match?.[1] === undefined || match[2] === undefined) return undefined
  return { width: Number(match[1]), height: Number(match[2]) }
}

export function parseXdpyinfo(output: string): { widthMm: number; heightMm: number } | undefined {
  const match = output.match(/dimensions:\s*(\d+)x(\d+)\s+pixels\s+\((\d+)x(\d+)\s+millimeters\)/)
  if (match?.[3] === undefined || match[4] === undefined) return undefined
  return { widthMm: Number(match[3]), heightMm: Number(match[4]) }
}

export function displayName(window: Pick<X11Window, "id" | "instance" | "cls" | "title">): string {
  return window.title || window.instance || window.cls || window.id
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
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size))
  }
  return chunks
}

export function splitCommand(input: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  for (const char of input.trim()) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === " " || char === "\t") {
      if (current.length > 0) {
        tokens.push(current)
        current = ""
      }
      continue
    }
    current += char
  }
  if (current.length > 0) tokens.push(current)
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
  // explicit "disabled" when the accessible reports insensitivity or defunctness.
  const normalized = states.filter((state): state is ElementStates[number] => KNOWN_STATES.has(state))
  if (states.length === 0) return normalized
  const hasEnabled = states.includes("enabled")
  const hasDisabled = normalized.includes("disabled")
  if (hasDisabled) return normalized
  if (hasEnabled) return normalized
  // A tree that reports only presentation states is still interactive.
  return normalized
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export function atspiReference(path: readonly number[]): string {
  return `atspi:${path.join(".")}`
}

export function parseAtspiReference(elementId: string): readonly number[] | undefined {
  if (!elementId.startsWith("atspi:")) return undefined
  const parts = elementId.slice("atspi:".length).split(".").map(Number)
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
  return {
    id: input.observationId,
    source: "accessibility",
    backend: "linux-at-spi",
    elements: [...elements, ...[...byApp.values()].flat()],
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
  maxApps?: number
  maxDepth?: number
  maxNodes?: number
}

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

  constructor(options: LinuxDriverOptions = {}) {
    this.runner = options.runner ?? defaultRunner
    this.display = options.display ?? process.env.DISPLAY
    this.maxApps = options.maxApps ?? 25
    this.maxDepth = options.maxDepth ?? 12
    this.maxNodes = options.maxNodes ?? 2000
  }

  get available(): boolean {
    return process.platform === "linux" && this.display !== undefined && this.display.length > 0
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
    const ids = parseWindowIds(list.stdout).slice(0, 64)
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
      return {
        id,
        ...parsed,
        active: activeId === id,
        ...(geometry ? parseXwininfo(geometry.stdout) : { x: 0, y: 0, width: 0, height: 0 }),
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

  async atspiApplications(): Promise<AtspiApplication[]> {
    if (!this.available) return []
    const result = await this.runner(
      "python3",
      [
        "-c",
        ATSPI_SCRIPT,
        "snapshot",
        "--max-apps",
        String(this.maxApps),
        "--max-depth",
        String(this.maxDepth),
        "--max-nodes",
        String(this.maxNodes),
      ],
      ATSPI_TIMEOUT_MS,
      this.env(),
    ).catch(() => undefined)
    if (!result) return []
    try {
      const parsed: unknown = JSON.parse(result.stdout)
      if (typeof parsed !== "object" || parsed === null || !("applications" in parsed)) return []
      const applications = (parsed as { applications: unknown }).applications
      if (!Array.isArray(applications)) return []
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
    } catch {
      return []
    }
  }

  invalidateObservation(): void {
    this.cachedObservation = undefined
  }

  async observe(applicationId?: string): Promise<Observation> {
    // Reuse a very recent unfiltered observation so one action does not pay
    // for several identical full-tree walks. Actions invalidate explicitly.
    if (
      applicationId === undefined &&
      this.cachedObservation !== undefined &&
      Date.now() - this.cachedObservation.at < OBSERVATION_TTL_MS
    ) {
      return this.cachedObservation.observation
    }
    this.observationCount += 1
    const observationId = `obs-${this.observationCount}`
    const [windows, applications] = await Promise.all([this.windows(), this.atspiApplications()])
    if (applicationId === undefined) return buildObservation({ windows, applications, observationId })
    const query = applicationId.toLowerCase()
    const matches = (value: string | undefined) => value !== undefined && value.toLowerCase().includes(query)
    const filteredApplications = applications.filter((app) => matches(app.name))
    const filteredWindows = windows.filter(
      (window) => matches(window.instance) || matches(window.cls) || matches(window.title),
    )
    if (filteredApplications.length === 0 && filteredWindows.length === 0) {
      const observation = buildObservation({ windows, applications, observationId })
      return {
        ...observation,
        warnings: [
          ...(observation.warnings ?? []),
          `No application matched "${applicationId}"; showing all windows and applications.`,
        ],
      }
    }
    return buildObservation({ windows: filteredWindows, applications: filteredApplications, observationId })
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
    return [
      {
        capability: "screen_read",
        status: capture,
        score: capture === "available" ? 0.9 : 0,
        reason:
          capture === "available"
            ? "Screen capture is available through spectacle or ffmpeg."
            : capture === "unavailable"
              ? "No screen capture backend is installed (expected spectacle or ffmpeg)."
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
        status: "available",
        score: 0.9,
        reason: "XTest global keyboard control works for any X11 application, whether or not it exposes accessibility.",
      },
      {
        capability: "pointer",
        status: "available",
        score: 0.9,
        reason: "XTest global pointer control works for any X11 application, whether or not it exposes accessibility.",
      },
      {
        capability: "direct_ui_control",
        status: "available",
        score: 0.85,
        reason: "Semantic AT-SPI actions where available, with global keyboard and pointer fallback everywhere else.",
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
        score: 0.9,
        reason: "Windows can be raised and focused through the window manager.",
      },
      {
        capability: "clipboard",
        status: "available",
        score: 0.85,
        reason: "Text copy and paste through the GTK clipboard; keyboard copy/paste remains the fallback.",
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
    const args =
      action === "set-text"
        ? ["-c", ATSPI_SCRIPT, "set-text", "--path", JSON.stringify(path), "--text", text ?? ""]
        : action === "focus"
          ? ["-c", ATSPI_SCRIPT, "focus", "--path", JSON.stringify(path)]
          : ["-c", ATSPI_SCRIPT, "act", "--path", JSON.stringify(path), "--action", action]
    const result = await this.runner("python3", args, ATSPI_TIMEOUT_MS, this.env()).catch((error: unknown) => {
      throw new Error(`AT-SPI action failed: ${runnerFailureReason(error)}`)
    })
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
    if (input.limit !== undefined) args.push("--limit", String(input.limit))
    const result = await this.runner("python3", args, ATSPI_TIMEOUT_MS * 2, this.env()).catch((error: unknown) => {
      throw new Error(`AT-SPI text read failed: ${runnerFailureReason(error)}`)
    })
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
      "python3",
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
    const result = await this.runner("python3", ["-c", XTEST_SCRIPT, ...args], timeoutMs, this.env()).catch(
      (error: unknown) => {
        throw new Error(`X11 input failed: ${runnerFailureReason(error)}`)
      },
    )
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
      "python3",
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

  async writeClipboard(text: string): Promise<ActionResult> {
    const result = await this.runner(
      "python3",
      ["-c", CLIPBOARD_SCRIPT, "set", "--text", text, "--hold", "0"],
      CLIPBOARD_TIMEOUT_MS,
      this.env(),
    ).catch((error: unknown) => ({ stdout: "", stderr: runnerFailureReason(error) }))
    try {
      const parsed: unknown = JSON.parse(result.stdout)
      if (typeof parsed === "object" && parsed !== null && (parsed as { ok?: unknown }).ok === true) {
        // Keep a short-lived owner alive in the background so a paste works
        // even when the desktop has no clipboard manager to persist content.
        await this.spawnDetached("python3", ["-c", CLIPBOARD_SCRIPT, "set", "--text", text, "--hold", "25"]).catch(
          () => undefined,
        )
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
    const result = await this.xtest(["release"]).catch(() => ({ ok: false as const }))
    if (!result.ok) return this.inputFailure("Could not reset keyboard state.", "input_failed")
    return { success: true, status: "success", message: "Released any held keys." }
  }

  async sendGlobalKey(keys: string): Promise<ActionResult> {
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
    const result = await this.xtest(["pointer-window"]).catch(() => undefined)
    if (result === undefined || !result.ok) return undefined
    const window = typeof result.window === "string" && /^0x[0-9a-f]+$/i.test(result.window) ? result.window : undefined
    return window === undefined || window === "0x0" ? undefined : { window }
  }

  async mouseDown(button = 1): Promise<ActionResult> {
    const result = await this.xtest(["down", "--button", String(button)])
    if (!result.ok) return this.inputFailure(String(result.error ?? "Pointer press failed."), "input_failed")
    return { success: true, status: "success", message: `Held mouse button ${button}.` }
  }

  async mouseUp(button = 1): Promise<ActionResult> {
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
            metadata: { application: "org.libreoffice.LibreOffice", arguments: args, backend: "flatpak" },
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
    const launched = await this.spawnDetached("xdg-open", [value])
    if (!launched.ok) return this.inputFailure(launched.error ?? `Could not open ${value}.`, "open_failed")
    return {
      success: true,
      status: "success",
      message: `Opened ${value}.`,
      metadata: { target: value, backend: "process" },
    }
  }

  async captureScreen(): Promise<ActionResult & { path?: string }> {
    const file = join(tmpdir(), `omnia-screenshot-${Date.now()}.png`)
    const size = await this.screenSize()
    const candidates: Array<{ file: string; args: string[] }> = [
      { file: "spectacle", args: ["-b", "-n", "-o", file] },
      ...(size === undefined
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
                this.display ?? ":0",
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
      this.captureStatus = "available"
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
    const env = this.env()
    const xrandr = await this.runner("xrandr", [], XPROP_TIMEOUT_MS, env).catch(() => undefined)
    const size = (xrandr === undefined ? undefined : parseXrandr(xrandr.stdout)) ?? (await this.screenSize())
    if (size === undefined) return undefined
    const xdpyinfo = await this.runner("xdpyinfo", [], XPROP_TIMEOUT_MS, env).catch(() => undefined)
    const mm = xdpyinfo === undefined ? undefined : parseXdpyinfo(xdpyinfo.stdout)
    if (mm === undefined) return { width: size.width, height: size.height }
    const scale = Math.round((size.width / (mm.widthMm / 25.4) / 96) * 100) / 100
    return { width: size.width, height: size.height, widthMm: mm.widthMm, heightMm: mm.heightMm, scale }
  }

  private async screenSize(): Promise<{ width: number; height: number } | undefined> {
    const result = await this.runner("xwininfo", ["-root"], XPROP_TIMEOUT_MS, this.env()).catch(() => undefined)
    if (!result) return undefined
    const width = Number(result.stdout.match(/Width:\s*(\d+)/)?.[1])
    const height = Number(result.stdout.match(/Height:\s*(\d+)/)?.[1])
    if (!Number.isFinite(width) || !Number.isFinite(height) || width === 0 || height === 0) return undefined
    return { width, height }
  }

  private spawnDetached(command: string, args: readonly string[] = []): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      const child = spawn(command, [...args], {
        detached: true,
        stdio: "ignore",
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
      child.once("error", (error) => resolve({ ok: false, error: error.message }))
      child.once("spawn", () => {
        child.unref()
        resolve({ ok: true })
      })
    })
  }
}

export function capabilityState(capabilities: readonly CapabilitySupport[], name: string): CapabilityState {
  return capabilities.find((capability) => capability.capability === name)?.status ?? "unknown"
}
