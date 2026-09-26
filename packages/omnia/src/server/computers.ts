import { access } from "node:fs/promises"
import type {
  ActionResult,
  CapabilitySupport,
  ComputerAction,
  ComputerInfo,
  ComputerTarget,
  ElementReference,
  ElementTarget,
  FindRequest,
  FindResult,
  JsonObject,
  Observation,
  ObservationRequest,
  UIElement,
  Verification,
} from "../protocol"
import { requiredScopesForAction, type OmniaScope, type PermissionManager } from "./permissions"
import type { EventBus } from "./events"

export interface BrowserTabSummary {
  readonly id: string
  readonly url: string
  readonly title?: string
}

export interface BrowserPageSummary {
  readonly url: string
  readonly title: string
  readonly text: string
  readonly length: number
  readonly hash: string
  readonly viewport?: { readonly width: number; readonly height: number }
}

export interface BrowserElementSummary {
  readonly id: string
  readonly role: string
  readonly name: string
  readonly visible?: boolean
  readonly disabled?: boolean
  readonly score?: number
  readonly rect?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly center?: { readonly x: number; readonly y: number }
}

export interface BrowserStatusSummary {
  readonly running: boolean
  readonly endpoint?: string
  readonly browser?: string
  readonly tabs: number
}

export interface BrowserController {
  status(): Promise<BrowserStatusSummary>
  open(url?: string): Promise<BrowserTabSummary>
  tabs(): Promise<BrowserTabSummary[]>
  activate(tabId: string): Promise<void>
  closeTab(tabId: string): Promise<void>
  navigate(url: string, tabId?: string): Promise<BrowserTabSummary>
  read(tabId?: string): Promise<BrowserPageSummary>
  find(query: string, options?: { tabId?: string; role?: string; limit?: number }): Promise<BrowserElementSummary[]>
  click(target: { tabId?: string; id?: string; x?: number; y?: number }): Promise<{
    clicked: boolean
    name?: string
    role?: string
    x?: number
    y?: number
    rect?: { x: number; y: number; width: number; height: number }
  }>
  type(target: { tabId?: string; id: string; text: string }): Promise<{ typed: boolean; value?: string }>
  key(key: string, tabId?: string): Promise<void>
  back(tabId?: string): Promise<void>
  forward(tabId?: string): Promise<void>
  reload(tabId?: string): Promise<void>
  currentTab?(): string | undefined
}

export interface Revalidation {
  readonly valid: boolean
  readonly reason?: string
}

export interface ServerComputerDriver {
  readonly id: string
  readonly backend: string
  getInfo(): Promise<ComputerInfo>
  capabilities(): readonly CapabilitySupport[]
  observe(request?: ObservationRequest): Promise<Observation>
  find(request: FindRequest): Promise<FindResult>
  execute(action: ComputerAction): Promise<ActionResult>
  readText?(input: { elementId?: string; application?: string; limit?: number }): Promise<
    ActionResult & { text?: string; length?: number; hash?: string }
  >
  readClipboard?(): Promise<ActionResult & { text?: string; length?: number; hash?: string }>
  writeClipboard?(text: string): Promise<ActionResult>
  pointerPosition?(): Promise<ActionResult & { x?: number; y?: number; held?: boolean }>
  hoverPointer?(x: number, y: number, holdMs?: number): Promise<ActionResult>
  mouseDown?(button?: number): Promise<ActionResult>
  mouseUp?(button?: number): Promise<ActionResult>
  releaseStuckKeys?(): Promise<ActionResult>
  revalidateTarget?(reference: ElementReference): Promise<Revalidation>
}

export interface ComputerSummary {
  readonly id: string
  readonly name: string
  readonly platform: string
  readonly backend: string
  readonly connected: boolean
  readonly capabilities: readonly CapabilitySupport[]
  readonly lastSeen?: number
}

export interface ExecuteContext {
  readonly sessionId?: string
  readonly approved?: boolean
  readonly approvedBy?: string
  readonly approvedScopes?: readonly OmniaScope[]
}

export interface DragEndpoint {
  readonly elementId?: string
  readonly x?: number
  readonly y?: number
}

export interface ServerActionRequest {
  readonly action: string
  readonly target?: ElementReference
  readonly query?: string
  readonly role?: string
  readonly window?: string
  readonly tab?: string
  readonly from?: DragEndpoint
  readonly to?: DragEndpoint
  readonly x?: number
  readonly y?: number
  readonly text?: string
  readonly start?: string
  readonly stop?: string
  readonly endKey?: string
  readonly key?: string
  readonly keys?: readonly string[]
  readonly app?: string
  readonly url?: string
  readonly path?: string
  readonly direction?: string
  readonly amount?: number
  readonly limit?: number
  readonly doc?: string
  readonly sheet?: string
  readonly range?: string
  readonly cell?: string
  readonly name?: string
  readonly type?: string
  readonly title?: string
  readonly rows?: readonly (readonly (string | number | boolean | null)[])[]
  readonly items?: readonly { readonly text: string; readonly style?: string }[]
  readonly bold?: boolean
  readonly background?: string
  readonly wrap?: boolean
  readonly fontSize?: number
  readonly index?: number
  readonly count?: number
  readonly width?: number
  readonly height?: number
  readonly button?: string
  readonly approve?: boolean
  readonly approvedBy?: string
  readonly approvedScopes?: readonly OmniaScope[]
  readonly sessionId?: string
}

export interface StepExpectation {
  readonly text?: string
  readonly window?: string
  readonly file?: string
}

export interface ServerBatchStep extends ServerActionRequest {
  readonly expect?: StepExpectation
}

export interface BatchStepResult {
  readonly index: number
  readonly action: string
  readonly success: boolean
  readonly message?: string
  readonly target?: { readonly role?: string; readonly name?: string }
  readonly resolvedBy?: string
  readonly confidence?: number
  readonly verification?: Verification
  readonly stateDelta?: StateDelta
  readonly error?: ActionResult["error"]
}

export interface BatchResult {
  readonly success: boolean
  readonly completed: number
  readonly total: number
  readonly failedAt?: number
  readonly steps: readonly BatchStepResult[]
  readonly message: string
}

const AMBIGUITY_GAP = 0.08

export interface TypeSlice {
  readonly text: string
  readonly error?: string
}

// The model can bound exactly what gets typed: `start` skips everything before
// the marker, `stop` ends immediately after the marker. A marker that is not
// found types nothing instead of risking a run-on.
export function sliceTypeText(text: string, start?: string, stop?: string): TypeSlice {
  let value = text
  if (start !== undefined && start.length > 0) {
    const index = value.indexOf(start)
    if (index < 0) return { text: "", error: `The start marker "${truncateMarker(start)}" is not in the text; nothing was typed.` }
    value = value.slice(index)
  }
  if (stop !== undefined && stop.length > 0) {
    const index = value.indexOf(stop)
    if (index < 0) return { text: "", error: `The stop marker "${truncateMarker(stop)}" is not in the text; nothing was typed.` }
    value = value.slice(0, index + stop.length)
  }
  return { text: value }
}

function truncateMarker(value: string): string {
  return value.length > 40 ? `${value.slice(0, 37)}…` : value
}

export interface ServerBatchRequest {
  readonly steps: readonly ServerBatchStep[]
  readonly stopOnError?: boolean
  readonly shouldStop?: () => boolean
  readonly approve?: boolean
  readonly approvedBy?: string
  readonly approvedScopes?: readonly OmniaScope[]
  readonly sessionId?: string
}

export interface ElementDelta {
  readonly role?: string
  readonly name?: string
  readonly fields?: readonly string[]
  readonly before?: Readonly<Record<string, string>>
  readonly after?: Readonly<Record<string, string>>
}

export interface StateDelta {
  readonly added: readonly { readonly role?: string; readonly name?: string }[]
  readonly removed: readonly { readonly role?: string; readonly name?: string }[]
  readonly changed: readonly ElementDelta[]
  readonly hasChanges: boolean
  readonly summary: string
  readonly highlights: readonly string[]
}

const MAX_DELTA_ITEMS = 20
const MAX_FIELD_CHARS = 120

// Launching, opening, activating, and closing are asynchronous at the desktop
// level: the window appears or disappears after the call returns, so the
// verification observation has to wait briefly before comparing state.
const SETTLE_ACTIONS = new Set(["launch", "launch_app", "open", "open_url", "open_file", "activate_app", "close_app"])
const SETTLE_DELAY_MS = 1200

function label(element: UIElement): { role?: string; name?: string } {
  const name = element.name ?? element.label ?? element.text
  return {
    ...(element.role === undefined ? {} : { role: element.role }),
    ...(name === undefined ? {} : { name: name.slice(0, MAX_FIELD_CHARS) }),
  }
}

function fieldSnapshot(element: UIElement): Record<string, string> {
  const snapshot: Record<string, string> = {}
  if (typeof element.name === "string" && element.name.length > 0) snapshot.name = element.name.slice(0, MAX_FIELD_CHARS)
  if (typeof element.text === "string" && element.text.length > 0) snapshot.text = element.text.slice(0, MAX_FIELD_CHARS)
  if (element.value !== undefined) snapshot.value = JSON.stringify(element.value).slice(0, MAX_FIELD_CHARS)
  if ((element.states ?? []).length > 0) snapshot.states = (element.states ?? []).join(",")
  return snapshot
}

function describeChange(element: UIElement, fields: readonly string[], before: UIElement): string {
  const name = element.name ?? element.label ?? element.role ?? "element"
  if (fields.includes("value") && element.value !== undefined) {
    return `field "${name}" now reads ${JSON.stringify(JSON.stringify(element.value).slice(0, MAX_FIELD_CHARS))}`
  }
  if (fields.includes("text")) {
    const beforeLength = typeof before.text === "string" ? before.text.length : 0
    const afterLength = typeof element.text === "string" ? element.text.length : 0
    return `text of "${name}" changed (${beforeLength} → ${afterLength} chars)`
  }
  if (fields.includes("name")) return `${element.role ?? "element"} renamed to "${element.name ?? ""}"`
  if (fields.includes("states")) {
    return `"${name}" states changed to [${(element.states ?? []).join(", ")}]`
  }
  return `${element.role ?? "element"} "${name}" changed`
}

export function computeStateDelta(previous: Observation | undefined, current: Observation | undefined): StateDelta {
  const before = new Map((previous?.elements ?? []).map((element) => [element.id ?? "", element]))
  const after = new Map((current?.elements ?? []).map((element) => [element.id ?? "", element]))
  const addedElements = [...after.entries()].filter(([id]) => id !== "" && !before.has(id)).map(([, element]) => element)
  const removedElements = [...before.entries()].filter(([id]) => id !== "" && !after.has(id)).map(([, element]) => element)
  const changed = [...after.entries()].flatMap(([id, element]): ElementDelta[] => {
    if (id === "") return []
    const prior = before.get(id)
    if (!prior) return []
    const fields = ["name", "value", "text", "states"].filter(
      (field) => JSON.stringify(prior[field as keyof UIElement]) !== JSON.stringify(element[field as keyof UIElement]),
    )
    return fields.length === 0
      ? []
      : [{ ...label(element), fields, before: fieldSnapshot(prior), after: fieldSnapshot(element) }]
  })

  const highlights: string[] = []
  for (const element of addedElements) {
    const name = element.name ?? element.label
    if (element.role === "window") highlights.push(`window "${name ?? "untitled"}" appeared`)
    else if (element.role === "dialog") highlights.push(`dialog "${name ?? "untitled"}" opened`)
    else if (element.role === "menu" || element.role === "menuitem") continue
    else if (name !== undefined) highlights.push(`${element.role ?? "element"} "${name}" appeared`)
  }
  for (const element of removedElements) {
    const name = element.name ?? element.label
    if (element.role === "window") highlights.push(`window "${name ?? "untitled"}" closed`)
    else if (element.role === "dialog") highlights.push(`dialog "${name ?? "untitled"}" closed`)
  }
  const changedWithSource = [...after.entries()].flatMap(([id, element]) => {
    const prior = before.get(id)
    return prior === undefined ? [] : [{ element, prior }]
  })
  for (const [index, change] of changed.entries()) {
    const source = changedWithSource[index]
    if (source === undefined) continue
    highlights.push(describeChange(source.element, change.fields ?? [], source.prior))
  }

  const hasChanges = addedElements.length > 0 || removedElements.length > 0 || changed.length > 0
  const summary =
    highlights.length > 0
      ? highlights.slice(0, 4).join("; ") + (highlights.length > 4 ? `; +${highlights.length - 4} more` : "")
      : hasChanges
        ? `${addedElements.length} added, ${removedElements.length} removed, ${changed.length} changed`
        : "No observable state change"
  return {
    added: addedElements.slice(0, MAX_DELTA_ITEMS).map((element) => label(element)),
    removed: removedElements.slice(0, MAX_DELTA_ITEMS).map((element) => label(element)),
    changed: changed.slice(0, MAX_DELTA_ITEMS),
    hasChanges,
    summary,
    highlights: highlights.slice(0, 8),
  }
}

export function verifyOutcome(result: ActionResult, delta: StateDelta): Verification {
  if (!result.success) {
    return { status: "failed", message: result.message ?? "The action did not succeed.", method: "observation-diff" }
  }
  if (delta.hasChanges) {
    return {
      status: "verified",
      message: `Observed state change: ${delta.summary}`,
      method: "observation-diff",
      evidence: [
        { kind: "state-delta", value: delta.summary },
        {
          kind: "state-changes",
          value: JSON.stringify({ added: delta.added, removed: delta.removed, changed: delta.changed }).slice(0, 2000),
        },
      ],
    }
  }
  return {
    status: "unverified",
    message: "The action was sent, but no observable state change was detected yet.",
    method: "observation-diff",
  }
}

export interface ComputerManagerOptions {
  readonly events: EventBus
  readonly permissions: PermissionManager
  readonly now?: () => number
  readonly browser?: BrowserController
  readonly onObservation?: (input: { computerId: string; applicationId?: string; observation: Observation }) => void
  readonly onSessionActivity?: (input: { sessionId: string; computerId: string; action: string; at: number }) => void
}

export interface ManagedComputer {
  readonly id: string
  readonly driver: ServerComputerDriver
  connectedAt: number
  lastSeen: number
  lastObservation?: Observation
}

export interface ExecuteOutcome {
  readonly httpStatus: number
  readonly result: ActionResult
}

export class ComputerManager {
  private readonly computers = new Map<string, ManagedComputer>()
  private readonly identities = new Map<string, { role?: string; name?: string }>()
  private readonly events: EventBus
  private readonly permissions: PermissionManager
  private readonly now: () => number
  private readonly browser: BrowserController | undefined
  private readonly onObservation: ComputerManagerOptions["onObservation"]
  private readonly onSessionActivity: ComputerManagerOptions["onSessionActivity"]

  constructor(options: ComputerManagerOptions) {
    this.events = options.events
    this.permissions = options.permissions
    this.now = options.now ?? Date.now
    this.browser = options.browser
    this.onObservation = options.onObservation
    this.onSessionActivity = options.onSessionActivity
  }

  register(driver: ServerComputerDriver, info?: Partial<ComputerSummary>): () => void {
    const at = this.now()
    this.computers.set(driver.id, { id: driver.id, driver, connectedAt: at, lastSeen: at })
    this.events.emit("computer.connected", {
      computerId: driver.id,
      data: { backend: driver.backend, name: info?.name ?? driver.id },
    })
    return () => {
      this.computers.delete(driver.id)
      this.events.emit("computer.disconnected", { computerId: driver.id })
    }
  }

  async list(): Promise<ComputerSummary[]> {
    return Promise.all(this.ids().map((id) => this.summary(id))).then((summaries) =>
      summaries.filter((summary): summary is ComputerSummary => summary !== undefined),
    )
  }

  get(id: string): ManagedComputer | undefined {
    return this.computers.get(id)
  }

  ids(): string[] {
    return [...this.computers.keys()]
  }

  async summary(id: string): Promise<ComputerSummary | undefined> {
    const computer = this.computers.get(id)
    if (!computer) return undefined
    const info = await computer.driver.getInfo().catch(() => undefined)
    return {
      id: computer.id,
      name: info?.name ?? computer.id,
      platform: info?.platform ?? "",
      backend: computer.driver.backend,
      connected: info?.connected !== false,
      capabilities: await this.capabilities(id),
      lastSeen: computer.lastSeen,
    }
  }

  async capabilities(id: string): Promise<readonly CapabilitySupport[]> {
    const computer = this.computers.get(id)
    if (!computer) return []
    return computer.driver.capabilities()
  }

  async observe(id: string, request?: ObservationRequest): Promise<Observation> {
    const computer = this.requireComputer(id)
    const observation = await computer.driver.observe(request)
    computer.lastObservation = observation
    this.remember(id, observation)
    this.onObservation?.({
      computerId: id,
      ...(request?.applicationId === undefined ? {} : { applicationId: request.applicationId }),
      observation,
    })
    computer.lastSeen = this.now()
    this.events.emit("observation.created", {
      computerId: id,
      data: {
        observationId: observation.id,
        elements: observation.elements?.length ?? 0,
        warnings: observation.warnings ?? [],
      },
    })
    return observation
  }

  async find(id: string, request: FindRequest): Promise<FindResult> {
    const computer = this.requireComputer(id)
    const result = await computer.driver.find(request)
    computer.lastSeen = this.now()
    if (result.observation !== undefined) this.remember(id, result.observation)
    for (const match of result.matches ?? result.results ?? []) this.rememberElement(id, match.element)
    return result
  }

  async execute(id: string, request: ServerActionRequest): Promise<ExecuteOutcome> {
    const computer = this.computers.get(id)
    if (!computer) {
      return {
        httpStatus: 404,
        result: { success: false, status: "unavailable", message: `Unknown computer ${id}.` },
      }
    }
    const actionType = request.action
    if (typeof actionType !== "string" || actionType.length === 0) {
      return { httpStatus: 400, result: { success: false, status: "rejected", message: "The action is required." } }
    }

    // Browser and office actions address their own surfaces, so they must
    // never pass through desktop query or window resolution.
    if (actionType.startsWith("browser_")) {
      return this.executeBrowser(request)
    }

    const byQuery = await this.resolveQuery(computer, request)
    if ("error" in byQuery) {
      return { httpStatus: byQuery.status, result: byQuery.error }
    }
    const focused = await this.resolveWindowFocus(computer, byQuery.request)
    if ("error" in focused) {
      return { httpStatus: focused.status, result: focused.error }
    }
    const resolved = await this.resolveApplicationAction(computer, focused.request)
    if ("error" in resolved) {
      return { httpStatus: resolved.status, result: resolved.error }
    }
    const effective = resolved.request
    const effectiveType = effective.action

    let actionRequest = effective
    if (effectiveType === "type" && typeof effective.text === "string") {
      const slice = sliceTypeText(effective.text, effective.start, effective.stop)
      if (slice.error !== undefined) {
        return {
          httpStatus: 400,
          result: {
            success: false,
            status: "rejected",
            message: slice.error,
            error: { code: "marker_not_found", message: slice.error, retryable: true },
          },
        }
      }
      actionRequest = { ...effective, text: slice.text }
    }

    if (effectiveType === "read_text") {
      if (!computer.driver.readText) {
        return {
          httpStatus: 501,
          result: { success: false, status: "unavailable", message: "This computer runtime cannot read text." },
        }
      }
      const elementId = effective.target?.elementId
      let application = effective.app
      if (application === undefined && effective.window !== undefined) {
        const observation = await computer.driver.observe().catch(() => undefined)
        const fragment = effective.window.toLowerCase()
        const window = (observation?.elements ?? []).find(
          (element) => element.role === "window" && String(element.name ?? "").toLowerCase().includes(fragment),
        )
        if (window && typeof window.metadata?.application === "string") application = window.metadata.application
      }
      if (elementId === undefined && application === undefined) {
        return {
          httpStatus: 400,
          result: {
            success: false,
            status: "rejected",
            message: "Reading text needs a target, query, app, or window.",
            error: {
              code: "invalid_action",
              message: "Reading text needs a target, query, app, or window.",
              retryable: true,
            },
          },
        }
      }
      const read = await computer.driver.readText({
        ...(elementId === undefined ? {} : { elementId }),
        ...(application === undefined ? {} : { application }),
        ...(effective.limit === undefined ? {} : { limit: effective.limit }),
      })
      if (!read.success) return { httpStatus: 500, result: read }
      return {
        httpStatus: 200,
        result: {
          ...read,
          metadata: {
            ...(read.metadata ?? {}),
            ...(read.length === undefined ? {} : { length: read.length }),
            ...(read.hash === undefined ? {} : { hash: read.hash }),
            preview: (read.text ?? "").slice(0, 4000),
          },
        },
      }
    }

    if (effectiveType === "paste_table") {
      if (!computer.driver.writeClipboard) {
        return {
          httpStatus: 501,
          result: { success: false, status: "unavailable", message: "This computer runtime cannot write the clipboard." },
        }
      }
      const tsv =
        request.text ??
        (request.rows ?? []).map((row) => row.map((value) => (value === null ? "" : String(value))).join("\t")).join("\n")
      if (tsv.length === 0) {
        return {
          httpStatus: 400,
          result: {
            success: false,
            status: "rejected",
            message: "paste_table needs text or rows.",
            error: { code: "invalid_action", message: "paste_table needs text or rows.", retryable: true },
          },
        }
      }
      const written = await computer.driver.writeClipboard(tsv)
      if (!written.success) return { httpStatus: 500, result: written }
      if (effective.target?.elementId !== undefined) {
        const focused = await computer.driver.execute({
          type: "click",
          target: { kind: "element", elementId: effective.target.elementId },
        })
        if (!focused.success) return { httpStatus: 500, result: focused }
      }
      const pasted = await computer.driver.execute({ type: "key", key: "ctrl+v" })
      if (!pasted.success) return { httpStatus: 500, result: pasted }
      const rows = (request.rows ?? []).length
      return {
        httpStatus: 200,
        result: {
          success: true,
          status: "success",
          message: `Pasted ${rows > 0 ? `${rows} rows` : `${tsv.length} characters`} from the clipboard.`,
          metadata: { characters: tsv.length, rows },
          ...(pasted.observation === undefined ? {} : { observation: pasted.observation }),
        },
      }
    }

    if (effectiveType === "read_clipboard") {
      if (!computer.driver.readClipboard) {
        return {
          httpStatus: 501,
          result: { success: false, status: "unavailable", message: "This computer runtime cannot read the clipboard." },
        }
      }
      const read = await computer.driver.readClipboard()
      if (!read.success) return { httpStatus: 500, result: read }
      return {
        httpStatus: 200,
        result: {
          ...read,
          metadata: {
            ...(read.metadata ?? {}),
            ...(read.length === undefined ? {} : { length: read.length }),
            ...(read.hash === undefined ? {} : { hash: read.hash }),
            preview: (read.text ?? "").slice(0, 4000),
          },
        },
      }
    }

    if (effectiveType === "write_clipboard") {
      if (!computer.driver.writeClipboard) {
        return {
          httpStatus: 501,
          result: { success: false, status: "unavailable", message: "This computer runtime cannot write the clipboard." },
        }
      }
      const written = await computer.driver.writeClipboard(effective.text ?? "")
      return { httpStatus: written.success ? 200 : 500, result: written }
    }

    if (effectiveType === "menu") {
      return this.executeMenu(computer, effective)
    }

    if (effectiveType === "inspect") {
      const elementId = effective.target?.elementId
      if (elementId === undefined || elementId.length === 0) {
        return {
          httpStatus: 400,
          result: {
            success: false,
            status: "rejected",
            message: "Inspect needs a target element id or a query.",
            error: { code: "invalid_action", message: "Inspect needs a target element id or a query.", retryable: true },
          },
        }
      }
      const observation = await computer.driver.observe()
      const elements = observation.elements ?? []
      const byId = new Map(elements.flatMap((element) => (element.id === undefined ? [] : [[element.id, element] as const])))
      const element = byId.get(elementId)
      if (element === undefined) {
        return {
          httpStatus: 409,
          result: {
            success: false,
            status: "rejected",
            message: `Element ${elementId} is not in the current observation.`,
            error: { code: "target_stale", message: `Element ${elementId} is not in the current observation.`, retryable: true },
          },
        }
      }
      const ancestors: Array<{ id?: string; role?: string; name?: string }> = []
      let parentId = element.parentId
      let guard = 0
      while (parentId !== undefined && guard < 12) {
        const parent = byId.get(parentId)
        if (parent === undefined) break
        ancestors.push({
          ...(parent.id === undefined ? {} : { id: parent.id }),
          ...(parent.role === undefined ? {} : { role: parent.role }),
          ...(parent.name === undefined ? {} : { name: parent.name }),
        })
        parentId = parent.parentId
        guard += 1
      }
      const children = elements
        .filter((candidate) => candidate.parentId === elementId)
        .slice(0, 25)
        .map((child) => ({
          ...(child.id === undefined ? {} : { id: child.id }),
          ...(child.role === undefined ? {} : { role: child.role }),
          ...(child.name === undefined ? {} : { name: child.name }),
          ...(child.states === undefined ? {} : { states: child.states }),
          ...(child.actions === undefined ? {} : { actions: child.actions }),
        }))
      const bounds = element.bounds
      return {
        httpStatus: 200,
        result: {
          success: true,
          status: "success",
          message: `Inspected ${element.role ?? "element"} "${element.name ?? element.text ?? elementId}".`,
          metadata: {
            element: {
              ...(element.id === undefined ? {} : { id: element.id }),
              ...(element.role === undefined ? {} : { role: element.role }),
              ...(element.name === undefined ? {} : { name: element.name }),
              ...(element.description === undefined ? {} : { description: element.description }),
              ...(element.text === undefined ? {} : { text: element.text.slice(0, 500) }),
              ...(element.value === undefined ? {} : { value: element.value }),
              ...(element.states === undefined ? {} : { states: element.states }),
              ...(element.actions === undefined ? {} : { actions: element.actions }),
              ...(bounds === undefined
                ? {}
                : {
                    bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
                    center: { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) },
                  }),
              ...(element.metadata?.application === undefined ? {} : { application: element.metadata.application }),
              ...(element.source === undefined ? {} : { source: element.source }),
            },
            ancestors,
            children,
          },
        },
      }
    }

    if (effectiveType === "get_context") {
      const [pointer, observation, browserStatus] = await Promise.all([
        computer.driver.pointerPosition?.().catch(() => undefined),
        computer.driver.observe().catch(() => undefined),
        this.browser?.status().catch(() => undefined),
      ])
      const elements = observation?.elements ?? []
      const focused = elements.find((element) => (element.states ?? []).includes("focused"))
      const activeWindow = elements.find(
        (element) => element.role === "window" && (element.states ?? []).includes("focused"),
      )
      const windows = elements
        .filter((element) => element.role === "window")
        .slice(0, 12)
        .map((element) => ({
          name: element.name ?? element.id ?? "window",
          ...(element.metadata?.application === undefined ? {} : { application: element.metadata.application }),
          ...(element.bounds === undefined
            ? {}
            : { bounds: { x: element.bounds.x, y: element.bounds.y, width: element.bounds.width, height: element.bounds.height } }),
        }))
      const describe = (element: (typeof elements)[number] | undefined) =>
        element === undefined
          ? undefined
          : {
              ...(element.role === undefined ? {} : { role: element.role }),
              ...(element.name === undefined ? {} : { name: element.name }),
              ...(typeof element.text === "string" ? { text: element.text.slice(0, 120) } : {}),
              ...(element.id === undefined ? {} : { id: element.id }),
              ...(element.bounds === undefined
                ? {}
                : {
                    center: {
                      x: Math.round(element.bounds.x + element.bounds.width / 2),
                      y: Math.round(element.bounds.y + element.bounds.height / 2),
                    },
                  }),
            }
      return {
        httpStatus: 200,
        result: {
          success: true,
          status: "success",
          message: `At ${activeWindow?.name ?? "the desktop"}${focused === undefined ? "" : `, focus on ${focused.role ?? "element"} "${focused.name ?? focused.text ?? focused.id ?? ""}"`}.`,
          metadata: {
            platform: observation?.environment?.platform ?? "unknown",
            ...(pointer?.x === undefined || pointer.y === undefined
              ? {}
              : { pointer: { x: pointer.x, y: pointer.y, held: pointer.held === true } }),
            ...(describe(activeWindow) === undefined ? {} : { activeWindow: describe(activeWindow)! }),
            ...(describe(focused) === undefined ? {} : { focused: describe(focused)! }),
            windows,
            ...(browserStatus === undefined
              ? {}
              : {
                  browser: {
                    running: browserStatus.running,
                    tabs: browserStatus.tabs,
                    ...(browserStatus.browser === undefined ? {} : { name: browserStatus.browser }),
                    ...(this.browser?.currentTab?.() === undefined ? {} : { currentTab: this.browser.currentTab!() }),
                  },
                }),
          },
        },
      }
    }

    if (effectiveType === "get_cursor") {
      if (!computer.driver.pointerPosition) {
        return {
          httpStatus: 501,
          result: { success: false, status: "unavailable", message: "This computer runtime cannot read the pointer." },
        }
      }
      const position = await computer.driver.pointerPosition()
      if (!position.success) return { httpStatus: 500, result: position }
      return {
        httpStatus: 200,
        result: {
          ...position,
          metadata: {
            ...(position.metadata ?? {}),
            ...(position.x === undefined ? {} : { x: position.x }),
            ...(position.y === undefined ? {} : { y: position.y }),
            held: position.held === true,
          },
        },
      }
    }

    if (effectiveType === "hover") {
      if (!computer.driver.hoverPointer) {
        return {
          httpStatus: 501,
          result: { success: false, status: "unavailable", message: "This computer runtime cannot hover the pointer." },
        }
      }
      const point = await this.resolvePoint(computer, effective)
      if (point === undefined) {
        return {
          httpStatus: 400,
          result: {
            success: false,
            status: "rejected",
            message: "Hovering needs a target or query with bounds.",
            error: { code: "target_not_found", message: "Hovering needs a target or query with bounds.", retryable: true },
          },
        }
      }
      const hovered = await computer.driver.hoverPointer(point.x, point.y, typeof effective.amount === "number" ? effective.amount : 600)
      return { httpStatus: hovered.success ? 200 : 500, result: hovered }
    }

    if (effectiveType === "mouse_down" || effectiveType === "mouse_up") {
      const method = effectiveType === "mouse_down" ? computer.driver.mouseDown : computer.driver.mouseUp
      if (!method) {
        return {
          httpStatus: 501,
          result: { success: false, status: "unavailable", message: "This computer runtime cannot press mouse buttons directly." },
        }
      }
      const pressed = await method.call(computer.driver, buttonNumber(effective.button))
      return { httpStatus: pressed.success ? 200 : 500, result: pressed }
    }

    if (effectiveType === "get_focus") {
      const observation = await computer.driver.observe()
      const focused = (observation.elements ?? []).find((element) => (element.states ?? []).includes("focused"))
      if (!focused) {
        return {
          httpStatus: 200,
          result: { success: true, status: "success", message: "No element reports keyboard focus.", metadata: { focused: null } },
        }
      }
      const label = focused.name ?? focused.text ?? focused.value ?? focused.id ?? "element"
      return {
        httpStatus: 200,
        result: {
          success: true,
          status: "success",
          message: `Focus is on ${focused.role ?? "element"} "${label}".`,
          metadata: {
            focused: {
              ...(focused.id === undefined ? {} : { id: focused.id }),
              ...(focused.role === undefined ? {} : { role: focused.role }),
              ...(focused.name === undefined ? {} : { name: focused.name }),
              ...(focused.value === undefined ? {} : { value: focused.value }),
              ...(typeof focused.text === "string" ? { text: focused.text.slice(0, 200) } : {}),
              ...(focused.metadata?.application === undefined ? {} : { application: focused.metadata.application }),
            },
          },
        },
      }
    }

    if (effectiveType === "release_keys") {
      if (!computer.driver.releaseStuckKeys) {
        return {
          httpStatus: 501,
          result: {
            success: false,
            status: "unavailable",
            message: "This computer runtime cannot reset keyboard state.",
          },
        }
      }
      const released = await computer.driver.releaseStuckKeys()
      return { httpStatus: released.success ? 200 : 500, result: released }
    }

    const action = toComputerAction(actionRequest)
    if (!action) {
      return {
        httpStatus: 400,
        result: {
          success: false,
          status: "rejected",
          message: `Action ${effectiveType} requires a target, text, or key that was not provided.`,
        },
      }
    }

    const required = requiredScopesForAction(effectiveType)
    const decision = this.permissions.evaluate(required, {
      sessionId: effective.sessionId,
      approval: {
        approved: effective.approve === true,
        ...(effective.approvedBy === undefined ? {} : { approvedBy: effective.approvedBy }),
        ...(effective.approvedScopes === undefined ? {} : { scopes: effective.approvedScopes }),
      },
    })
    this.events.emit("action.requested", {
      computerId: id,
      ...(effective.sessionId === undefined ? {} : { sessionId: effective.sessionId }),
      data: { action: effectiveType, requiredScopes: required },
    })
    if (!decision.allowed) {
      this.events.emit("permission.requested", {
        computerId: id,
        ...(effective.sessionId === undefined ? {} : { sessionId: effective.sessionId }),
        data: { action: effectiveType, missing: decision.missing, reason: decision.reason },
      })
      return {
        httpStatus: decision.status === "denied" ? 403 : 428,
        result: {
          success: false,
          status: "rejected",
          message: decision.reason ?? "Permission required.",
          error: {
            code: decision.status === "denied" ? "permission_denied" : "permission_required",
            message: decision.reason ?? "Permission required.",
            retryable: decision.status !== "denied",
            details: { missing: decision.missing },
          },
        },
      }
    }

    if (effective.approve === true) {
      this.events.emit("permission.decided", {
        computerId: id,
        ...(effective.sessionId === undefined ? {} : { sessionId: effective.sessionId }),
        data: { action: effectiveType, approvedBy: effective.approvedBy ?? "session", scopes: required },
      })
    }

    const before = computer.lastObservation
    this.events.emit("action.started", {
      computerId: id,
      ...(effective.sessionId === undefined ? {} : { sessionId: effective.sessionId }),
      data: { action: effectiveType, target: effective.target?.elementId ?? effective.target?.id },
    })

    const identityIssue = await this.checkIdentity(computer, effective)
    if (identityIssue !== undefined) {
      const context = await this.failureContext(computer)
      const result: ActionResult = {
        success: false,
        status: "rejected",
        message: identityIssue.message,
        error: { code: "target_mismatch", message: identityIssue.message, retryable: true, details: identityIssue.details },
        metadata: { context: [...context] },
      }
      this.events.emit("action.failed", {
        computerId: id,
        ...(effective.sessionId === undefined ? {} : { sessionId: effective.sessionId }),
        data: { action: effectiveType, reason: result.message },
      })
      return { httpStatus: 409, result }
    }

    const needsRevalidation =
      effectiveType !== "screenshot" &&
      effectiveType !== "launch" &&
      effectiveType !== "launch_app" &&
      effectiveType !== "open" &&
      effectiveType !== "open_url" &&
      effectiveType !== "open_file"
    if (
      needsRevalidation &&
      computer.driver.revalidateTarget &&
      action.target !== undefined &&
      typeof action.target === "object" &&
      action.target.kind === "element"
    ) {
      const revalidation = await computer.driver.revalidateTarget({
        kind: "element",
        elementId: action.target.elementId,
      })
      if (!revalidation.valid) {
        const result: ActionResult = {
          success: false,
          status: "rejected",
          message: revalidation.reason ?? "The target is stale.",
          error: { code: "target_stale", message: revalidation.reason ?? "The target is stale.", retryable: true },
        }
        this.events.emit("action.failed", {
          computerId: id,
          ...(effective.sessionId === undefined ? {} : { sessionId: effective.sessionId }),
          data: { action: effectiveType, reason: result.message },
        })
        return { httpStatus: 409, result }
      }
    }

    let executed = await computer.driver.execute(action)
    if (
      executed.success &&
      effectiveType === "type" &&
      typeof effective.endKey === "string" &&
      effective.endKey.length > 0
    ) {
      const endKey = await computer.driver.execute({ type: "key", key: effective.endKey })
      if (!endKey.success) return { httpStatus: 500, result: endKey }
      executed = {
        ...executed,
        ...(endKey.observation === undefined ? {} : { observation: endKey.observation }),
        metadata: { ...(executed.metadata ?? {}), endKey: effective.endKey },
      }
    }
    computer.lastSeen = this.now()
    if (effective.sessionId !== undefined) {
      this.onSessionActivity?.({
        sessionId: effective.sessionId,
        computerId: id,
        action: effectiveType,
        at: computer.lastSeen,
      })
    }
    const settles = SETTLE_ACTIONS.has(effectiveType)
    const settled =
      executed.observation ?? (settles ? await this.settle(computer) : computer.lastObservation)
    const after = settled ?? computer.lastObservation
    if (after) computer.lastObservation = after
    const delta = computeStateDelta(before, after)
    const readback = await this.verifyTypedText(computer, effective, actionRequest)
    const verification = readback ?? verifyOutcome(executed, delta)
    const failureContext = executed.success ? undefined : await this.failureContext(computer)
    const result: ActionResult = {
      ...executed,
      verification,
      metadata: {
        ...(executed.metadata ?? {}),
        computerId: id,
        action: effectiveType,
        ...("resolution" in byQuery && byQuery.resolution !== undefined
          ? { resolvedBy: byQuery.resolution.resolvedBy, confidence: byQuery.resolution.confidence }
          : {}),
        ...(failureContext === undefined ? {} : { context: failureContext }),
        stateDelta: {
          added: delta.added.map((item) => ({ ...item })),
          removed: delta.removed.map((item) => ({ ...item })),
          changed: delta.changed.map((item) => ({
            ...item,
            ...(item.fields === undefined ? {} : { fields: [...item.fields] }),
            ...(item.before === undefined ? {} : { before: { ...item.before } }),
            ...(item.after === undefined ? {} : { after: { ...item.after } }),
          })),
          hasChanges: delta.hasChanges,
          summary: delta.summary,
          highlights: [...delta.highlights],
        },
      },
    }
    if (result.success) {
      this.events.emit(verification.status === "verified" ? "action.verified" : "action.completed", {
        computerId: id,
        ...(effective.sessionId === undefined ? {} : { sessionId: effective.sessionId }),
        data: {
          action: effectiveType,
          target: effective.target?.elementId ?? effective.target?.id,
          verification: verification.status,
          summary: delta.summary,
        },
      })
    } else {
      this.events.emit("action.failed", {
        computerId: id,
        ...(effective.sessionId === undefined ? {} : { sessionId: effective.sessionId }),
        data: { action: effectiveType, reason: result.message },
      })
    }
    return { httpStatus: 200, result }
  }

  private async resolvePoint(
    computer: ManagedComputer,
    request: ServerActionRequest,
  ): Promise<{ x: number; y: number } | undefined> {
    if (typeof request.x === "number" && typeof request.y === "number") return { x: request.x, y: request.y }
    const elementId = request.target?.elementId
    if (elementId === undefined) return undefined
    const observation = await computer.driver.observe().catch(() => undefined)
    const element = (observation?.elements ?? []).find((candidate) => candidate.id === elementId)
    const bounds = element?.bounds
    if (bounds === undefined) return undefined
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  }

  private remember(computerId: string, observation: Observation): void {
    for (const element of observation.elements ?? []) this.rememberElement(computerId, element)
  }

  private rememberElement(computerId: string, element: UIElement): void {
    const id = element.id
    if (id === undefined || id.length === 0) return
    if (this.identities.size > 50000) this.identities.clear()
    this.identities.set(`${computerId}:${id}`, {
      ...(element.role === undefined ? {} : { role: element.role }),
      ...(element.name === undefined ? {} : { name: element.name }),
    })
  }

  private async checkIdentity(
    computer: ManagedComputer,
    request: ServerActionRequest,
  ): Promise<
    | {
        message: string
        details: {
          expected: { readonly role?: string; readonly name?: string }
          actual: { readonly role?: string; readonly name?: string }
        }
      }
    | undefined
  > {
    if (request.query !== undefined) return undefined
    const elementId = request.target?.elementId
    if (elementId === undefined || elementId.length === 0) return undefined
    const cached = this.identities.get(`${computer.id}:${elementId}`)
    if (cached === undefined) return undefined
    const observation = await computer.driver.observe().catch(() => undefined)
    const current = (observation?.elements ?? []).find((element) => element.id === elementId)
    if (current === undefined) return undefined
    const roleChanged = cached.role !== undefined && current.role !== undefined && cached.role !== current.role
    const nameChanged = cached.name !== undefined && current.name !== undefined && cached.name !== current.name
    if (!roleChanged && !nameChanged) return undefined
    return {
      message: `Element ${elementId} is no longer the ${cached.role ?? "element"} "${cached.name ?? ""}"; it is now ${current.role ?? "unknown"} "${current.name ?? ""}". Re-find the control before acting.`,
      details: {
        expected: {
          ...(cached.role === undefined ? {} : { role: cached.role }),
          ...(cached.name === undefined ? {} : { name: cached.name }),
        },
        actual: {
          ...(current.role === undefined ? {} : { role: current.role }),
          ...(current.name === undefined ? {} : { name: current.name }),
        },
      },
    }
  }

  private async verifyTypedText(
    computer: ManagedComputer,
    request: ServerActionRequest,
    actionRequest: ServerActionRequest,
  ): Promise<Verification | undefined> {
    if (request.action !== "type" || !computer.driver.readText) return undefined
    const elementId = request.target?.elementId
    const expected = actionRequest.text ?? ""
    if (elementId === undefined || expected.trim().length === 0) return undefined
    const read = await computer.driver
      .readText({ elementId, limit: Math.max(4000, expected.length + 2000) })
      .catch(() => undefined)
    if (!read?.success || typeof read.text !== "string" || read.text.length === 0) return undefined
    const probe = expected.trim().slice(0, Math.min(80, expected.trim().length))
    const matched = read.text.includes(probe)
    if (matched) {
      return {
        status: "verified",
        message: `Text readback confirms the target contains the typed text (${read.length ?? read.text.length} chars${read.hash === undefined ? "" : `, hash ${read.hash}`}).`,
        method: "text-readback",
        evidence: [{ kind: "text-readback", value: JSON.stringify({ length: read.length, hash: read.hash, matched: probe }) }],
      }
    }
    return {
      status: "unverified",
      message: `Typed text was not found in the target's readback (${read.length ?? read.text.length} chars, begins ${JSON.stringify(read.text.slice(0, 80))}).`,
      method: "text-readback",
    }
  }

  private async failureContext(computer: ManagedComputer): Promise<readonly string[]> {
    const observation = await computer.driver.observe().catch(() => undefined)
    const elements = observation?.elements ?? []
    const focused = elements.find((element) => (element.states ?? []).includes("focused"))
    const application = String(focused?.metadata?.application ?? "")
    const lines: string[] = []
    if (focused !== undefined) {
      lines.push(`focused: ${focused.role ?? "element"} "${focused.name ?? focused.text ?? focused.id ?? ""}"`)
    }
    for (const element of elements) {
      if (lines.length >= 15) break
      if (element.role === "window" || element.role === "dialog") {
        const name = element.name ?? element.label
        if (name !== undefined) lines.push(`${element.role}: ${name}`)
        continue
      }
      const elementApplication = String(element.metadata?.application ?? "")
      if (application.length > 0 && elementApplication !== application) continue
      const name = element.name ?? element.label
      if (name === undefined || name.length === 0) continue
      if (element.role === "menu" || element.role === "menubar" || element.role === "filler" || element.role === "panel") continue
      lines.push(`${element.role ?? "element"}: ${name}`)
    }
    return lines
  }

  private async executeBrowser(request: ServerActionRequest): Promise<{ httpStatus: number; result: ActionResult }> {
    const browser = this.browser
    if (browser === undefined) {
      return {
        httpStatus: 501,
        result: {
          success: false,
          status: "unavailable",
          message: "No browser runtime is connected to this Omnia Server.",
          error: { code: "operation_unavailable", message: "No browser runtime is connected.", retryable: false },
        },
      }
    }
    const action = request.action
    const tab = request.tab
    const ok = (message: string, metadata: JsonObject, verification?: Verification): { httpStatus: number; result: ActionResult } => ({
      httpStatus: 200,
      result: {
        success: true,
        status: "success",
        message,
        metadata,
        ...(verification === undefined ? {} : { verification }),
      },
    })
    const fail = (code: string, message: string, retryable = true): { httpStatus: number; result: ActionResult } => ({
      httpStatus: 500,
      result: {
        success: false,
        status: "failed",
        message,
        error: { code, message, retryable },
      },
    })
    const snapshot = async (): Promise<{ hash: string; tabs: number } | undefined> => {
      const [page, tabs] = await Promise.all([
        browser.read(tab).catch(() => undefined),
        browser.tabs().catch(() => undefined),
      ])
      if (page === undefined && tabs === undefined) return undefined
      return { hash: page?.hash ?? "", tabs: tabs?.length ?? 0 }
    }
    const verificationFor = (before: { hash: string; tabs: number } | undefined, after: { hash: string; tabs: number } | undefined): Verification | undefined => {
      if (before === undefined || after === undefined) return undefined
      if (after.tabs > before.tabs) return { status: "verified", message: "A new browser tab opened.", method: "browser-tab-count" }
      if (after.hash !== before.hash) return { status: "verified", message: "The page content changed.", method: "browser-content-hash" }
      return { status: "unverified", message: "The page content did not change yet.", method: "browser-content-hash" }
    }

    this.events.emit("browser.action", {
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      data: { action },
    })

    try {
      switch (action) {
        case "browser_status": {
          const status = await browser.status()
          return ok(
            status.running
              ? `Browser running${status.browser === undefined ? "" : ` (${status.browser})`} with ${status.tabs} tab(s).`
              : "The browser runtime is not running yet; the first browser action starts it.",
            { status: { ...status } },
          )
        }
        case "browser_open": {
          const opened = await browser.open(request.url)
          return ok(`Opened ${opened.url}.`, { tab: { id: opened.id, url: opened.url } })
        }
        case "browser_tabs": {
          const tabs = await browser.tabs()
          return ok(`${tabs.length} tab(s) open.`, {
            tabs: tabs.map((entry) => ({
              id: entry.id,
              url: entry.url,
              ...(entry.title === undefined ? {} : { title: entry.title }),
            })),
          })
        }
        case "browser_activate_tab": {
          if (tab === undefined) return fail("invalid_action", "Activating a tab needs a tab id.")
          await browser.activate(tab)
          return ok(`Activated tab ${tab}.`, { tab })
        }
        case "browser_close_tab": {
          if (tab === undefined) return fail("invalid_action", "Closing a tab needs a tab id.")
          await browser.closeTab(tab)
          return ok(`Closed tab ${tab}.`, { tab })
        }
        case "browser_navigate": {
          if (request.url === undefined || request.url.length === 0) return fail("invalid_action", "Navigating needs a url.")
          const before = await snapshot()
          const navigated = await browser.navigate(request.url, tab)
          const after = await snapshot()
          const verification = verificationFor(before, after)
          return ok(`Navigated to ${navigated.url}.`, { tab: { id: navigated.id, url: navigated.url } }, verification)
        }
        case "browser_read": {
          const page = await browser.read(tab)
          return ok(`${page.title === "" ? page.url : page.title} (${page.length} characters).`, {
            url: page.url,
            title: page.title,
            length: page.length,
            hash: page.hash,
            text: page.text,
            ...(page.viewport === undefined ? {} : { viewport: { width: page.viewport.width, height: page.viewport.height } }),
            ...(browser.currentTab?.() === undefined ? {} : { tab: browser.currentTab!() }),
          })
        }
        case "browser_find": {
          if (request.query === undefined || request.query.trim().length === 0) return fail("invalid_action", "Finding needs a query.")
          const candidates = await browser.find(request.query, {
            tabId: tab,
            ...(request.role === undefined ? {} : { role: request.role }),
            limit: typeof request.limit === "number" ? request.limit : 8,
          })
          return ok(
            candidates.length === 0
              ? `No page element matched "${request.query}".`
              : `Found ${candidates.length} page element(s) for "${request.query}".`,
            {
              ...(browser.currentTab?.() === undefined ? {} : { tab: browser.currentTab!() }),
              candidates: candidates.map((candidate) => ({
                id: candidate.id,
                role: candidate.role,
                name: candidate.name,
                ...(candidate.visible === undefined ? {} : { visible: candidate.visible }),
                ...(candidate.disabled === undefined ? {} : { disabled: candidate.disabled }),
                ...(candidate.score === undefined ? {} : { score: candidate.score }),
                ...(candidate.rect === undefined
                  ? {}
                  : { rect: { x: candidate.rect.x, y: candidate.rect.y, width: candidate.rect.width, height: candidate.rect.height } }),
                ...(candidate.center === undefined ? {} : { center: { x: candidate.center.x, y: candidate.center.y } }),
              })),
            },
          )
        }
        case "browser_click": {
          const id = request.target?.elementId
          const before = await snapshot()
          const clicked = await browser.click({
            ...(tab === undefined ? {} : { tabId: tab }),
            ...(id === undefined ? {} : { id }),
            ...(typeof request.x === "number" ? { x: request.x } : {}),
            ...(typeof request.y === "number" ? { y: request.y } : {}),
          })
          const after = await snapshot()
          const verification = verificationFor(before, after)
          return ok(
            `Clicked ${clicked.role ?? "element"} "${clicked.name ?? id ?? "page"}"${clicked.x === undefined ? "" : ` at pixel ${clicked.x},${clicked.y}`}.`,
            {
              clicked: {
                ...(clicked.name === undefined ? {} : { name: clicked.name }),
                ...(clicked.role === undefined ? {} : { role: clicked.role }),
                ...(id === undefined ? {} : { id }),
                ...(clicked.x === undefined ? {} : { x: clicked.x }),
                ...(clicked.y === undefined ? {} : { y: clicked.y }),
                ...(clicked.rect === undefined
                  ? {}
                  : { rect: { x: clicked.rect.x, y: clicked.rect.y, width: clicked.rect.width, height: clicked.rect.height } }),
              },
              ...(browser.currentTab?.() === undefined ? {} : { tab: browser.currentTab!() }),
            },
            verification,
          )
        }
        case "browser_type": {
          const id = request.target?.elementId
          if (id === undefined) return fail("invalid_action", "Typing on a page needs an element id from browser_find.")
          const before = await snapshot()
          const typed = await browser.type({ ...(tab === undefined ? {} : { tabId: tab }), id, text: request.text ?? "" })
          const after = await snapshot()
          const matched = typed.value === (request.text ?? "")
          const verification: Verification = matched
            ? { status: "verified", message: "The field now contains the typed text.", method: "browser-value-readback" }
            : verificationFor(before, after) ?? { status: "unverified", message: "The field value could not be confirmed.", method: "browser-value-readback" }
          return ok(
            `Typed into the page field${typed.value === undefined ? "" : `: "${typed.value}"`}.`,
            { ...(typed.value === undefined ? {} : { value: typed.value }) },
            verification,
          )
        }
        case "browser_key": {
          await browser.key(request.key ?? "Enter", tab)
          return ok(`Pressed ${request.key ?? "Enter"} in the browser.`, { key: request.key ?? "Enter" })
        }
        case "browser_back":
        case "browser_forward":
        case "browser_reload": {
          const before = await snapshot()
          if (action === "browser_back") await browser.back(tab)
          else if (action === "browser_forward") await browser.forward(tab)
          else await browser.reload(tab)
          const after = await snapshot()
          return ok(`${action === "browser_back" ? "Went back" : action === "browser_forward" ? "Went forward" : "Reloaded"}.`, {}, verificationFor(before, after))
        }
        default:
          return fail("operation_unavailable", `The browser action ${action} is not supported.`, false)
      }
    } catch (error) {
      return fail("browser_error", error instanceof Error ? error.message : "The browser action failed.")
    }
  }

  private async executeMenu(computer: ManagedComputer, request: ServerActionRequest): Promise<{ httpStatus: number; result: ActionResult }> {
    const path = (request.query ?? request.text ?? "").split(">").map((part) => part.trim()).filter((part) => part.length > 0)
    if (path.length === 0) {
      return {
        httpStatus: 400,
        result: {
          success: false,
          status: "rejected",
          message: "A menu action needs a path such as 'Sheet > Rename Sheet'.",
          error: { code: "invalid_action", message: "A menu action needs a path such as 'Sheet > Rename Sheet'.", retryable: true },
        },
      }
    }
    const clicked: string[] = []
    for (const label of path) {
      const find = await computer.driver.find({ query: label, limit: 5 })
      const match = (find.matches ?? find.results ?? [])[0]
      if (match?.element?.id === undefined) {
        const message = `Menu item "${label}" was not found. Open the menu first and check the label.`
        return {
          httpStatus: 404,
          result: {
            success: false,
            status: "unavailable",
            message,
            error: { code: "menu_item_not_found", message, retryable: true, details: { path, reached: clicked } },
          },
        }
      }
      const outcome = await computer.driver.execute({
        type: "click",
        target: { kind: "element", elementId: match.element.id },
      })
      if (!outcome.success) return { httpStatus: 500, result: outcome }
      clicked.push(label)
      await new Promise((resolve) => setTimeout(resolve, 350))
    }
    const observation = await computer.driver.observe().catch(() => undefined)
    if (observation !== undefined) computer.lastObservation = observation
    return {
      httpStatus: 200,
      result: {
        success: true,
        status: "success",
        message: `Selected menu path ${clicked.join(" > ")}.`,
        metadata: { path: clicked },
        ...(observation === undefined ? {} : { observation }),
      },
    }
  }

  private requireComputer(id: string): ManagedComputer {
    const computer = this.computers.get(id)
    if (!computer) throw new Error(`Unknown computer ${id}.`)
    return computer
  }

  private async resolveQuery(
    computer: ManagedComputer,
    request: ServerActionRequest,
  ): Promise<
    | { request: ServerActionRequest; resolution?: { resolvedBy: string; confidence?: number } }
    | { status: number; error: ActionResult }
  > {
    if (request.target !== undefined) return { request }
    const query = request.query?.trim()
    if (query === undefined || query.length === 0) return { request }
    const found = await computer.driver
      .find({ query, ...(request.role === undefined ? {} : { role: request.role }), limit: 5 })
      .catch(() => undefined)
    const all = found?.matches ?? found?.results ?? []
    const unusable = (element: UIElement): boolean =>
      (element.states ?? []).some((state) => state === "disabled" || state === "hidden" || state === "offscreen")
    const usable = all.some((match) => !unusable(match.element)) ? all.filter((match) => !unusable(match.element)) : all
    const matches = preferHierarchy(usable, found?.observation)
    if (matches.length === 0) {
      return {
        status: 404,
        error: {
          success: false,
          status: "unavailable",
          message: `No control matched "${query}".`,
          error: {
            code: "target_not_found",
            message: `No control matched "${query}". Observe the application again; its interface may have changed.`,
            retryable: true,
          },
        },
      }
    }
    const best = matches[0]!
    const challenger = matches[1]
    const ambiguous =
      challenger !== undefined &&
      challenger.element.id !== best.element.id &&
      best.score - challenger.score < AMBIGUITY_GAP
    if (ambiguous) {
      const candidates = matches.slice(0, 3).map((match) => ({
        ...(match.element.id === undefined ? {} : { id: match.element.id }),
        ...(match.element.role === undefined ? {} : { role: match.element.role }),
        ...(match.element.name ?? match.element.text) === undefined
          ? {}
          : { name: match.element.name ?? match.element.text },
        score: match.score,
      }))
      const summary = candidates
        .map((candidate) => `${candidate.role ?? "element"} "${candidate.name ?? candidate.id ?? "?"}" (id=${candidate.id ?? "?"})`)
        .join(", ")
      return {
        status: 409,
        error: {
          success: false,
          status: "rejected",
          message: `"${query}" matched more than one control.`,
          error: {
            code: "target_ambiguous",
            message: `"${query}" is ambiguous: ${summary}. Pass the target element id or narrow with role or app.`,
            retryable: true,
            details: { candidates },
          },
        },
      }
    }
    const elementId = best.element.id
    if (elementId === undefined) {
      return {
        status: 404,
        error: {
          success: false,
          status: "unavailable",
          message: `The best match for "${query}" has no stable identifier.`,
          error: { code: "target_not_found", message: "The best match has no stable identifier.", retryable: true },
        },
      }
    }
    return {
      request: {
        ...request,
        target: {
          kind: "element",
          elementId,
          ...(best.element.role === undefined ? {} : { role: best.element.role }),
        },
      },
      resolution: { resolvedBy: "semantic-query", confidence: best.score },
    }
  }

  private async resolveWindowFocus(
    computer: ManagedComputer,
    request: ServerActionRequest,
  ): Promise<{ request: ServerActionRequest } | { status: number; error: ActionResult }> {
    const globalInput = ["type", "key", "hotkey", "press_keys", "paste", "copy", "scroll"]
    const wantsWindow =
      request.action === "focus_window" ||
      (request.window !== undefined && request.target === undefined && globalInput.includes(request.action))
    if (!wantsWindow) return { request }

    const fragment = (request.window ?? request.query ?? "").trim().toLowerCase()
    const observation = await computer.driver.observe().catch(() => undefined)
    const windows = (observation?.elements ?? []).filter(
      (element) => element.role === "window" && element.id !== undefined,
    )
    const matching =
      fragment.length === 0
        ? []
        : windows.filter((window) => {
            const name = String(window.name ?? "").toLowerCase()
            const application = String(window.metadata?.application ?? "").toLowerCase()
            return name.includes(fragment) || application.includes(fragment)
          })
    const target = matching.find((window) => (window.states ?? []).includes("focused")) ?? matching[0]

    if (request.action === "focus_window") {
      if (target?.id === undefined) {
        const available = windows.map((window) => window.name).filter((name): name is string => typeof name === "string")
        return {
          status: 404,
          error: {
            success: false,
            status: "unavailable",
            message: `No open window matches "${request.window ?? request.query ?? ""}".`,
            error: {
              code: "window_not_found",
              message: `No open window matches "${request.window ?? request.query ?? ""}".`,
              retryable: true,
              details: { windows: available.slice(0, 10) },
            },
          },
        }
      }
      return {
        request: {
          ...request,
          action: "focus",
          target: { kind: "element", elementId: target.id },
        },
      }
    }

    if (target?.id !== undefined && !(target.states ?? []).includes("focused")) {
      const focused = await this.execute(computer.id, {
        action: "focus",
        target: { kind: "element", elementId: target.id },
        ...(request.approve === undefined ? {} : { approve: request.approve }),
        ...(request.approvedBy === undefined ? {} : { approvedBy: request.approvedBy }),
        ...(request.approvedScopes === undefined ? {} : { approvedScopes: request.approvedScopes }),
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      })
      if (!focused.result.success) return { status: focused.httpStatus, error: focused.result }
    }
    return { request }
  }

  async executeBatch(id: string, batch: ServerBatchRequest): Promise<{ httpStatus: number; result: BatchResult }> {
    if (batch.steps.length === 0) {
      return {
        httpStatus: 400,
        result: { success: false, completed: 0, total: 0, steps: [], message: "The batch contains no steps." },
      }
    }
    const stopOnError = batch.stopOnError !== false
    const steps: BatchStepResult[] = []
    for (let index = 0; index < batch.steps.length; index += 1) {
      if (batch.shouldStop?.() === true) {
        return {
          httpStatus: 200,
          result: {
            success: false,
            completed: steps.length,
            total: batch.steps.length,
            steps,
            message: `Stopped after ${steps.length} step(s) because the client disconnected.`,
          },
        }
      }
      const step = batch.steps[index]!
      const outcome = await this.execute(id, {
        ...step,
        approve: step.approve ?? batch.approve,
        ...(step.approvedBy ?? batch.approvedBy) === undefined
          ? {}
          : { approvedBy: step.approvedBy ?? batch.approvedBy },
        ...(step.approvedScopes ?? batch.approvedScopes) === undefined
          ? {}
          : { approvedScopes: step.approvedScopes ?? batch.approvedScopes },
        sessionId: step.sessionId ?? batch.sessionId,
      })
      const result = outcome.result
      const metadata = (result.metadata ?? {}) as Record<string, unknown>
      let stepResult: BatchStepResult = {
        index,
        action: step.action,
        success: result.success,
        ...(result.message === undefined ? {} : { message: result.message }),
        ...(typeof metadata.resolvedBy === "string" ? { resolvedBy: metadata.resolvedBy } : {}),
        ...(typeof metadata.confidence === "number" ? { confidence: metadata.confidence } : {}),
        ...(result.verification === undefined ? {} : { verification: result.verification }),
        ...(metadata.stateDelta === undefined ? {} : { stateDelta: metadata.stateDelta as StateDelta }),
        ...(result.error === undefined ? {} : { error: result.error }),
      }
      if (stepResult.success && step.expect !== undefined) {
        const expectation = await this.checkExpectation(id, step.expect, step.sessionId ?? batch.sessionId)
        if (!expectation.met) {
          stepResult = {
            ...stepResult,
            success: false,
            message: expectation.message,
            error: {
              code: "expectation_unmet",
              message: expectation.message,
              retryable: true,
            },
          }
        }
      }
      steps.push(stepResult)
      if (!stepResult.success && stopOnError) {
        return {
          httpStatus: 200,
          result: {
            success: false,
            completed: steps.length - 1,
            total: batch.steps.length,
            failedAt: index,
            steps,
            message: `Step ${index + 1} (${step.action}) failed: ${stepResult.message ?? "unknown failure"}`,
          },
        }
      }
    }
    return {
      httpStatus: 200,
      result: {
        success: steps.every((step) => step.success),
        completed: steps.filter((step) => step.success).length,
        total: steps.length,
        steps,
        message: `Completed ${steps.filter((step) => step.success).length} of ${steps.length} step(s).`,
      },
    }
  }

  private async checkExpectation(
    id: string,
    expect: StepExpectation,
    sessionId: string | undefined,
  ): Promise<{ met: boolean; message: string }> {
    const computer = this.requireComputer(id)
    if (expect.file !== undefined) {
      const decision = this.permissions.evaluate(["FILES_READ"], { sessionId })
      if (!decision.allowed) {
        return { met: false, message: "Verifying an expected file needs FILES_READ approval." }
      }
      const exists = await access(expect.file).then(
        () => true,
        () => false,
      )
      return exists
        ? { met: true, message: `Verified the file ${expect.file} exists.` }
        : { met: false, message: `Expected file ${expect.file} does not exist.` }
    }
    const observation = await computer.driver.observe().catch(() => undefined)
    const elements = observation?.elements ?? []
    if (expect.window !== undefined) {
      const needle = expect.window.toLowerCase()
      const found = elements.some(
        (element) => element.role === "window" && String(element.name ?? "").toLowerCase().includes(needle),
      )
      return found
        ? { met: true, message: `Verified a window matching "${expect.window}" is open.` }
        : { met: false, message: `No open window matches "${expect.window}".` }
    }
    if (expect.text !== undefined) {
      const needle = expect.text.toLowerCase()
      const found = elements.some((element) =>
        [element.name, element.text, element.value, element.description]
          .filter((value): value is string => typeof value === "string")
          .some((value) => value.toLowerCase().includes(needle)),
      )
      return found
        ? { met: true, message: `Verified "${expect.text}" is present.` }
        : { met: false, message: `Expected text "${expect.text}" did not appear.` }
    }
    return { met: true, message: "No expectation to verify." }
  }

  private async settle(computer: ManagedComputer): Promise<Observation | undefined> {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS))
    return computer.driver.observe().then(
      (observation) => observation,
      () => computer.lastObservation,
    )
  }

  private async resolveApplicationAction(
    computer: ManagedComputer,
    request: ServerActionRequest,
  ): Promise<{ request: ServerActionRequest } | { status: number; error: ActionResult }> {
    if (request.action !== "activate_app" && request.action !== "close_app") return { request }
    const app = (request.app ?? request.text ?? "").trim().toLowerCase()
    if (app.length === 0) {
      return {
        status: 400,
        error: { success: false, status: "rejected", message: `The ${request.action} action requires an app.` },
      }
    }
    const observation = await computer.driver.observe().catch(() => undefined)
    const window = (observation?.elements ?? []).find((element) => {
      if (element.role !== "window") return false
      const application = String(element.metadata?.application ?? "").toLowerCase()
      const name = String(element.name ?? "").toLowerCase()
      return application.includes(app) || name.includes(app)
    })
    if (!window?.id) {
      const available = (observation?.elements ?? [])
        .filter((element) => element.role === "window")
        .map((element) => element.name)
        .filter((name): name is string => typeof name === "string")
      return {
        status: 404,
        error: {
          success: false,
          status: "unavailable",
          message: `No open window belongs to ${request.app ?? request.text ?? app}.`,
          error: {
            code: "application_not_found",
            message: `No open window belongs to ${app}.`,
            retryable: true,
            details: { windows: available.slice(0, 10) },
          },
        },
      }
    }
    return {
      request: {
        ...request,
        action: request.action === "activate_app" ? "focus" : "close",
        target: { kind: "element", elementId: window.id },
      },
    }
  }
}

function toComputerAction(request: ServerActionRequest): ComputerAction | undefined {
  const target = request.target
  switch (request.action) {
    case "observe":
    case "find":
    case "read":
    case "wait":
      return { type: "observe" }
    case "screenshot":
      return { type: "screenshot" }
    case "launch":
    case "launch_app": {
      const applicationId = request.app ?? request.text ?? ""
      return applicationId.length > 0 ? { type: "launch", applicationId } : undefined
    }
    case "open":
    case "open_url":
    case "open_file": {
      const value = request.url ?? request.path ?? request.text ?? ""
      return value.length > 0 ? { type: "open", target: value } : undefined
    }
    case "click":
      return pointOrElement(request)
        ? { type: "click", target: pointOrElement(request)!, ...durationMetadata(request) }
        : undefined
    case "middle_click":
      return pointOrElement(request)
        ? { type: "click", target: pointOrElement(request)!, button: "middle", ...durationMetadata(request) }
        : undefined
    case "menu":
      return undefined
    case "double_click":
    case "doubleclick":
      return pointOrElement(request)
        ? { type: "doubleclick", target: pointOrElement(request)!, ...durationMetadata(request) }
        : undefined
    case "right_click":
    case "rightclick":
      return pointOrElement(request)
        ? { type: "rightclick", target: pointOrElement(request)!, ...durationMetadata(request) }
        : undefined
    case "focus":
      return target ? { type: "focus", target: elementTarget(target) } : undefined
    case "type":
      return typeof request.text === "string"
        ? target
          ? { type: "type", target: elementTarget(target), text: request.text }
          : { type: "type", text: request.text }
        : undefined
    case "set_value":
    case "setvalue":
      return target && typeof request.text === "string"
        ? { type: "setvalue", target: elementTarget(target), value: request.text }
        : undefined
    case "key":
      return typeof request.key === "string" ? { type: "key", key: request.key } : undefined
    case "hotkey":
    case "press_keys":
      return request.keys && request.keys.length > 0 ? { type: "key", key: request.keys.join("+") } : undefined
    case "scroll": {
      const direction =
        request.direction === "up" || request.direction === "down" || request.direction === "left" || request.direction === "right"
          ? request.direction
          : "down"
      return {
        type: "scroll",
        direction,
        amount: typeof request.amount === "number" ? request.amount : 3,
        ...(target ? { target: elementTarget(target) } : {}),
        ...durationMetadata(request),
      }
    }
    case "move":
      return pointOrElement(request)
        ? { type: "move", target: pointOrElement(request)!, ...durationMetadata(request) }
        : undefined
    case "drag": {
      const from = dragTarget(request.from)
      const to = dragTarget(request.to)
      return from !== undefined && to !== undefined ? { type: "drag", from, to, ...durationMetadata(request) } : undefined
    }
    case "copy":
      return { type: "copy", ...(target ? { target: elementTarget(target) } : {}) }
    case "paste":
      return {
        type: "paste",
        text: request.text ?? "",
        ...(target ? { target: elementTarget(target) } : {}),
      }
    case "wait":
      return { type: "wait", ms: typeof request.amount === "number" ? request.amount : 800 }
    case "dismiss":
      return { type: "dismiss" }
    case "close":
      return target ? { type: "close", target: elementTarget(target) } : undefined
    default:
      return undefined
  }
}

function ancestorRoles(element: UIElement, byId: Map<string, UIElement>): string[] {
  const roles: string[] = []
  let parentId = element.parentId
  let guard = 0
  while (parentId !== undefined && guard < 24) {
    const parent = byId.get(parentId)
    if (parent === undefined) break
    if (parent.role !== undefined) roles.push(parent.role)
    parentId = parent.parentId
    guard += 1
  }
  return roles
}

// Menu dependencies expose several controls with the same name (menu bar
// entry, context menu, toolbar button). Prefer the one reached through the
// canonical hierarchy so opening "Insert" selects the menu bar entry instead
// of failing on a tie.
function preferHierarchy<T extends { element: UIElement }>(matches: readonly T[], observation: Observation | undefined): T[] {
  if (matches.length < 2) return [...matches]
  const byId = new Map((observation?.elements ?? []).flatMap((element) => (element.id === undefined ? [] : [[element.id, element] as const])))
  const ranked = matches.map((match) => {
    const roles = ancestorRoles(match.element, byId)
    const rank = roles.includes("menubar") ? 3 : roles.includes("menu") ? 2 : 1
    return { match, rank }
  })
  const best = Math.max(...ranked.map((entry) => entry.rank))
  if (best <= 1) return [...matches]
  const preferred = ranked.filter((entry) => entry.rank === best).map((entry) => entry.match)
  return preferred.length > 0 ? preferred : [...matches]
}

function dragTarget(endpoint: DragEndpoint | undefined): ComputerTarget | undefined {
  if (endpoint === undefined) return undefined
  if (typeof endpoint.elementId === "string" && endpoint.elementId.length > 0) {
    return { kind: "element", elementId: endpoint.elementId }
  }
  if (typeof endpoint.x === "number" && typeof endpoint.y === "number") {
    return { kind: "point", x: endpoint.x, y: endpoint.y }
  }
  return undefined
}

function pointOrElement(request: ServerActionRequest): ComputerTarget | undefined {
  if (typeof request.x === "number" && typeof request.y === "number") {
    return { kind: "point", x: request.x, y: request.y }
  }
  return request.target === undefined ? undefined : elementTarget(request.target)
}

function durationMetadata(request: ServerActionRequest): { metadata?: { durationMs: number } } {
  return typeof request.amount === "number" ? { metadata: { durationMs: request.amount } } : {}
}

function buttonNumber(button: string | undefined): number {
  if (button === "middle") return 2
  if (button === "right") return 3
  return 1
}

function elementTarget(reference: ElementReference): ElementTarget {
  return { kind: "element", elementId: reference.elementId ?? reference.id ?? "" }
}
