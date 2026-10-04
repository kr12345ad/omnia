import { isComputerAction } from "../protocol"
import type {
  ActionResult,
  CapabilitySupport,
  CommandRequest,
  CommandResult,
  ComputerAction,
  ComputerDriver,
  ComputerInfo,
  ElementReference,
  FindRequest,
  FindResult,
  Observation,
  ObservationRequest,
  PermissionRequirement,
  UIElement,
} from "../protocol"
import { createCuaHostDriver } from "../cua/host-driver"
import { LinuxHostDriver, parseAtspiReference } from "./linux"
import type { InputGrabEvent, InputGrabReleasedBy } from "./linux"

export const INPUT_PERMISSION: PermissionRequirement = {
  id: "computer.input",
  description: "Send keyboard, pointer, and interface actions to applications on this computer.",
  status: "prompt",
  capabilities: ["keyboard", "pointer", "direct_ui_control"],
  promptable: true,
  reason: "Interface actions change application state. Each action needs approval unless this permission is allowed.",
}

const INPUT_CAPABILITIES = new Set(["keyboard", "pointer", "direct_ui_control"])

export function withInputPermission(capabilities: readonly CapabilitySupport[]): CapabilitySupport[] {
  return capabilities.map((capability) =>
    INPUT_CAPABILITIES.has(capability.capability)
      ? { ...capability, permissions: [...(capability.permissions ?? []), INPUT_PERMISSION] }
      : capability,
  )
}

export interface HostRevalidation {
  valid: boolean
  reference?: ElementReference
  reason?: string
}

export interface HostDriver extends ComputerDriver {
  readonly engine?: unknown
  getInfo: () => Promise<ComputerInfo>
  observe: (request?: ObservationRequest) => Promise<Observation>
  find: (request: FindRequest) => Promise<FindResult>
  execute: (action: ComputerAction) => Promise<ActionResult>
  runCommand?: (request: CommandRequest) => Promise<ActionResult & { command?: CommandResult }>
  readText?: (input: { elementId?: string; application?: string; limit?: number }) => Promise<
    ActionResult & { text?: string; length?: number; hash?: string }
  >
  readClipboard?: () => Promise<ActionResult & { text?: string; length?: number; hash?: string }>
  writeClipboard?: (text: string) => Promise<ActionResult>
  writeClipboardImage?: (path: string) => Promise<ActionResult>
  pointerPosition?: () => Promise<ActionResult & { x?: number; y?: number; held?: boolean }>
  hoverPointer?: (x: number, y: number, holdMs?: number) => Promise<ActionResult>
  mouseDown?: (button?: number) => Promise<ActionResult>
  mouseUp?: (button?: number) => Promise<ActionResult>
  releaseStuckKeys?: () => Promise<ActionResult>
  minimizeWindowId?: (windowId: string) => Promise<ActionResult>
  restoreWindowId?: (windowId: string) => Promise<ActionResult>
  grabInput?: (reason?: string) => Promise<ActionResult & { frozen?: boolean; supported?: boolean; mode?: string }>
  releaseInput?: () => Promise<
    ActionResult & { frozen?: boolean; releasedBy?: InputGrabReleasedBy; supported?: boolean; mode?: string }
  >
  inputGrabState?: () => Promise<
    ActionResult & { frozen?: boolean; supported?: boolean; reason?: string; releasedBy?: InputGrabReleasedBy }
  >
  subscribeInputGrab?: (listener: (event: InputGrabEvent) => void) => () => void
  dispose?: () => void
  revalidateTarget(reference: ElementReference): Promise<HostRevalidation>
}

function attachWarning(result: ActionResult, key: string, warning: string | undefined): ActionResult {
  if (warning === undefined) return result
  return { ...result, metadata: { ...(result.metadata ?? {}), [key]: warning } }
}

function stale(message: string): ActionResult {
  return {
    success: false,
    status: "rejected",
    message,
    error: { code: "target_stale", message, retryable: true },
  }
}

function unavailable(message: string): ActionResult {
  return {
    success: false,
    status: "unavailable",
    message,
    error: { code: "operation_unavailable", message, retryable: false },
  }
}

async function currentElement(
  host: LinuxHostDriver,
  elementId: string,
): Promise<{ element: UIElement; observation: Observation } | undefined> {
  const observation = await host.observe()
  const element = observation.elements?.find((candidate) => candidate.id === elementId)
  if (!element) return undefined
  return { element, observation }
}

function atspiActions(element: UIElement): string[] {
  const raw = element.metadata === undefined ? undefined : element.metadata.atspiActions
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : []
}

function elementTargetOf(action: { target?: unknown }): string | undefined {
  const target = action.target
  if (target === undefined || target === null || typeof target !== "object") return undefined
  const record = target as { kind?: unknown; elementId?: unknown }
  return record.kind === "element" && typeof record.elementId === "string" ? record.elementId : undefined
}

function pointTargetOf(action: { target?: unknown }): { x: number; y: number } | undefined {
  const target = action.target
  if (target === undefined || target === null || typeof target !== "object") return undefined
  const record = target as { kind?: unknown; x?: unknown; y?: unknown }
  if (record.kind !== "point" || typeof record.x !== "number" || typeof record.y !== "number") return undefined
  return { x: record.x, y: record.y }
}

function centerOf(bounds: NonNullable<UIElement["bounds"]>): { x: number; y: number } {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
}

const TEXT_LIKE_ROLES = new Set([
  "textbox",
  "entry",
  "combobox",
  "combo box",
  "spinbutton",
  "spin button",
  "text field",
  "document text",
  "text",
  "paragraph",
])

// People click near the start of a text field rather than dead center, and
// dead center of a control. This keeps caret placement predictable.
export function aimPoint(element: UIElement): { x: number; y: number } | undefined {
  const bounds = element.bounds
  if (bounds === undefined) return undefined
  const role = (element.role ?? "").toLowerCase()
  const x = TEXT_LIKE_ROLES.has(role)
    ? bounds.x + Math.min(28, Math.max(6, bounds.width * 0.08))
    : bounds.x + bounds.width / 2
  const y = bounds.y + bounds.height / 2
  return { x, y }
}

function durationOf(action: { metadata?: Readonly<Record<string, unknown>> }, fallback: number): number {
  const value = action.metadata?.durationMs
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : fallback
}

function buttonOf(action: unknown, fallback: number): number {
  const value = (action as { button?: unknown }).button
  if (value === "middle") return 2
  if (value === "right") return 3
  if (value === "left") return 1
  return fallback
}

function windowIdOf(elementId: string | undefined): string | undefined {
  if (elementId === undefined || !elementId.startsWith("x11:")) return undefined
  const id = elementId.slice("x11:".length)
  return /^0x[0-9a-f]+$/i.test(id) ? id : undefined
}

function containsPoint(bounds: NonNullable<UIElement["bounds"]>, point: { x: number; y: number }): boolean {
  return (
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
  )
}

export function resolveOwningWindow(
  element: UIElement,
  observation: Observation,
): UIElement | undefined {
  const windows = (observation.elements ?? []).filter((candidate) => candidate.role === "window" && candidate.id !== undefined)
  if (windows.length === 0) return undefined
  const center = element.bounds === undefined ? undefined : centerOf(element.bounds)
  if (center !== undefined) {
    const containing = windows.filter((window) => window.bounds !== undefined && containsPoint(window.bounds, center))
    const focusedContaining = containing.find((window) => (window.states ?? []).includes("focused"))
    if (focusedContaining) return focusedContaining
    if (containing.length === 1) return containing[0]
    if (containing.length > 1) {
      const smallest = [...containing].sort(
        (a, b) => (a.bounds?.width ?? 0) * (a.bounds?.height ?? 0) - (b.bounds?.width ?? 0) * (b.bounds?.height ?? 0),
      )
      return smallest[0]
    }
  }
  const application = String(element.metadata?.application ?? "").toLowerCase()
  if (application.length > 0) {
    const appWindow = windows.find((window) => {
      const candidate = String(window.metadata?.application ?? "").toLowerCase()
      if (candidate.length === 0) return false
      return candidate.includes(application) || application.includes(candidate)
    })
    if (appWindow) return appWindow
  }
  const focused = windows.find((window) => (window.states ?? []).includes("focused"))
  if (focused) return focused
  return windows.length === 1 ? windows[0] : undefined
}

export function createLegacyHostDriver(host: LinuxHostDriver = new LinuxHostDriver()): HostDriver {
  const execute = async (action: ComputerAction): Promise<ActionResult> => {
    // Dismiss carries no target by design, but the protocol guard still
    // requires one; admit it here so Escape is actually delivered.
    const type = action.type
    if (!isComputerAction(action) && type !== "dismiss") {
      return {
        success: false,
        status: "failed",
        message: "The action is not a valid computer action.",
        error: { code: "invalid_action", message: "The action is not a valid computer action.", retryable: false },
      }
    }

    const withObservation = async (result: ActionResult): Promise<ActionResult> => {
      if (!result.success) return result
      host.invalidateObservation()
      const observation = await host.observe().catch(() => undefined)
      return { ...result, ...(observation === undefined ? {} : { observation }) }
    }

    if (action.type === "observe" || action.type === "find") {
      const observation = await host.observe()
      return { success: true, status: "success", message: "Observation captured.", observation }
    }

    if (action.type === "read") {
      const elementId = elementTargetOf(action)
      if (elementId !== undefined && elementId.startsWith("atspi:")) {
        return host.readText({ elementId })
      }
      const target = action.target
      if (target !== undefined && typeof target === "object" && target.kind === "application") {
        return host.readText({ application: target.applicationId })
      }
      const observation = await host.observe()
      return { success: true, status: "success", message: "Observation captured.", observation }
    }

    if (action.type === "wait") {
      const requested = typeof action.ms === "number" && action.ms > 0 ? action.ms : 800
      await new Promise((resolve) => setTimeout(resolve, Math.min(requested, 30000)))
      const observation = await host.observe().catch(() => undefined)
      return {
        success: true,
        status: "success",
        message: `Waited ${Math.min(requested, 30000)}ms.`,
        ...(observation === undefined ? {} : { observation }),
      }
    }

    if (action.type === "copy") {
      const point = pointTargetOf(action) ?? (await elementCenter(action))
      if (point) {
        const clicked = await host.clickAt(point.x, point.y)
        if (!clicked.success) return clicked
      }
      return withObservation(await host.sendGlobalKey("ctrl+c"))
    }

    if (action.type === "paste") {
      const point = pointTargetOf(action) ?? (await elementCenter(action))
      if (point) {
        const clicked = await host.clickAt(point.x, point.y)
        if (!clicked.success) return clicked
      }
      if (action.text.length > 0) {
        const written = await host.writeClipboard(action.text)
        if (written.success) {
          const pasted = await host.sendGlobalKey("ctrl+v")
          if (pasted.success) return withObservation({ ...pasted, message: `Pasted ${action.text.length} characters from the clipboard.` })
        }
        return withObservation(await host.typeText(action.text))
      }
      return withObservation(await host.sendGlobalKey("ctrl+v"))
    }

    if (action.type === "dismiss") {
      return withObservation(await host.sendGlobalKey("Escape"))
    }

    if (action.type === "screenshot") {
      return host.captureScreen()
    }

    if (action.type === "key" || action.type === "keypress") {
      const key = action.key ?? (action.type === "key" ? action.keys : undefined)
      if (typeof key !== "string" || key.length === 0) {
        return unavailable("The key action requires a key.")
      }
      const warning = await globalFocusWarning(action)
      return withObservation(attachWarning(await host.sendGlobalKey(key), "focusWarning", warning))
    }

    if (action.type === "press_keys" || action.type === "press") {
      const keys = action.keys
      const warning = await globalFocusWarning(action)
      return withObservation(attachWarning(await host.sendGlobalKey(keys), "focusWarning", warning))
    }

    if (action.type === "launch") {
      return host.launchApp(action.applicationId)
    }

    if (action.type === "open") {
      return host.openTarget(action.target)
    }

    if (action.type === "close") {
      const elementId = elementTargetOf(action)
      const windowId = windowIdOf(elementId)
      if (windowId !== undefined) return withObservation(await host.closeWindowId(windowId))
      return unavailable("Closing is only supported for a window target on this computer.")
    }

    if (action.type === "scroll") {
      const direction = action.direction ?? (action.deltaY !== undefined && action.deltaY < 0 ? "up" : "down")
      const amount = action.amount ?? Math.max(1, Math.min(10, Math.round(Math.abs(action.deltaY ?? 3))))
      const point = pointTargetOf(action) ?? (await elementCenter(action))
      return withObservation(
        await host.scrollPointer(direction, amount, point?.x, point?.y, durationOf(action, 200)),
      )
    }

    if (action.type === "move") {
      const point = pointTargetOf(action) ?? (await elementCenter(action))
      if (!point) return unavailable("A move action requires a point or an element with bounds.")
      return withObservation(await host.movePointer(point.x, point.y, durationOf(action, 240)))
    }

    if (action.type === "drag") {
      const from = pointTargetOf({ target: action.from }) ?? (await elementCenter({ target: action.from }))
      const to = pointTargetOf({ target: action.to }) ?? (await elementCenter({ target: action.to }))
      if (!from || !to) return unavailable("A drag action requires two resolvable targets.")
      const moved = await host.movePointer(from.x, from.y, durationOf(action, 200))
      if (!moved.success) return moved
      const dragged = await host.dragPointer(from.x, from.y, to.x, to.y, buttonOf(action, 1), durationOf(action, 600))
      return withObservation(dragged)
    }

    const target = action.target
    if (typeof target === "string" || !target) {
      if (action.type === "type" && typeof action.text === "string") {
        const warning = await globalFocusWarning(action)
        return withObservation(attachWarning(await host.typeText(action.text), "focusWarning", warning))
      }
      return unavailable("Only semantic element or point targets are executable; the action had no target.")
    }

    if (target.kind === "point") {
      const button = buttonOf(action, action.type === "rightclick" ? 3 : 1)
      const count = action.type === "doubleclick" ? 2 : 1
      if (action.type === "click" || action.type === "doubleclick" || action.type === "rightclick") {
        return withObservation(await host.clickAt(target.x, target.y, button, count, durationOf(action, 240)))
      }
      return unavailable(`Action ${action.type} is not supported for point targets.`)
    }

    if (target.kind !== "element") {
      return unavailable("Only semantic element or point targets are executable by this driver.")
    }

    const elementId = target.elementId
    const path = parseAtspiReference(elementId)
    const current = await currentElement(host, elementId)
    if (!current) return stale(`Target ${elementId} is not present in the current observation.`)
    // Focus first so the click lands in the right window, and remember when it
    // did not take: on KDE/Wayland an activation request can be refused, and a
    // blind click then hits whatever is really focused.
    const unfocusedWindow = await ensureWindowFocused(current.element, current.observation)

    if (action.type === "type" && typeof action.text === "string") {
      if (path) {
        const result = await host.executeAtspi(path, "set-text", action.text)
        if (result.success) return withObservation(await decorate(result, current.element))
      }
      const point = aimPoint(current.element)
      if (!point) return unavailable(`Element ${elementId} has no bounds to focus for typing.`)
      const focused = await host.clickAt(point.x, point.y, 1, 1, durationOf(action, 200))
      if (!focused.success) return focused
      const typed = await host.typeText(action.text)
      const warning = await focusWarning(elementId).catch(() => undefined)
      return withObservation(
        warning === undefined
          ? typed
          : { ...typed, metadata: { ...(typed.metadata ?? {}), focusWarning: warning } },
      )
    }

    if (action.type === "setvalue" && action.value !== undefined) {
      if (path) {
        const result = await host.executeAtspi(path, "set-text", String(action.value))
        if (result.success) return withObservation(await decorate(result, current.element))
      }
      const point = aimPoint(current.element)
      if (!point) return unavailable(`Element ${elementId} has no bounds to set a value.`)
      const focused = await host.clickAt(point.x, point.y, 1, 1, durationOf(action, 200))
      if (!focused.success) return focused
      // Same window-focus contract as click: never type into a field in a window
      // that never came to the front.
      const valueWarning = await focusWarning(elementId).catch(() => undefined)
      const windowWarning =
        unfocusedWindow === undefined
          ? undefined
          : `The value was set while "${unfocusedWindow}" was not the focused window; it may have gone to the wrong field. Activate the window and re-observe before retrying.`
      const warning = windowWarning ?? valueWarning
      const written = await host.typeText(String(action.value))
      return withObservation(
        warning === undefined ? written : { ...written, metadata: { ...(written.metadata ?? {}), focusWarning: warning } },
      )
    }

    if (action.type === "focus") {
      if (path) {
        const result = await host.executeAtspi(path, "focus")
        if (result.success) return withObservation(await decorate(result, current.element))
      }
      const windowId = windowIdOf(elementId)
      if (windowId !== undefined) {
        const activated = await host.activateWindowId(windowId)
        if (unfocusedWindow !== undefined) {
          // Report the truth: the window was asked to come forward and did not.
          return withObservation({
            ...activated,
            metadata: {
              ...(activated.metadata ?? {}),
              focusWarning: `"${unfocusedWindow}" did not take focus. Another window may hold it; raise the target window yourself or retry.`,
            },
          })
        }
        return withObservation(activated)
      }
      return unavailable(`Element ${elementId} cannot be focused.`)
    }

    if (action.type === "click" || action.type === "doubleclick" || action.type === "rightclick") {
      if (path) {
        const candidate =
          atspiActions(current.element).find((name) => ["click", "press", "activate"].includes(name.toLowerCase())) ??
          atspiActions(current.element)[0]
        if (candidate) {
          const result = await host.executeAtspi(path, candidate)
          if (result.success) return withObservation(await decorate(result, current.element))
        }
      }
      const point = aimPoint(current.element)
      if (!point) return unavailable(`Element ${elementId} exposes no invokable action and has no bounds.`)
      const button = buttonOf(action, action.type === "rightclick" ? 3 : 1)
      const count = action.type === "doubleclick" ? 2 : 1
      const clicked = await host.clickAt(point.x, point.y, button, count, durationOf(action, 240))
      if (!clicked.success) return clicked
      const bounds = boundsWarning(current.element, current.observation, point)
      const occludedBy = await occlusionWarning(current.element, current.observation)
      const decorated = await decorate(clicked, current.element)
      return withObservation({
        ...decorated,
        metadata: {
          ...(decorated.metadata ?? {}),
          ...(bounds === undefined ? {} : { boundsWarning: bounds }),
          ...(occludedBy === undefined ? {} : { occludedBy }),
          ...(unfocusedWindow === undefined
            ? {}
            : { focusWarning: `The click was aimed at "${unfocusedWindow}", which did not come to the front; the click may have landed in the window that actually has focus. Activate the window and re-observe before retrying.` }),
        },
      })
    }

    return unavailable(`Action ${action.type} is not supported by this driver.`)
  }

  async function elementCenter(action: { target?: unknown }): Promise<{ x: number; y: number } | undefined> {
    const elementId = elementTargetOf(action)
    if (elementId === undefined) return undefined
    const current = await currentElement(host, elementId).catch(() => undefined)
    if (!current?.element.bounds) return undefined
    return centerOf(current.element.bounds)
  }

  async function focusWarning(elementId: string): Promise<string | undefined> {
    const observation = await host.observe().catch(() => undefined)
    const focused = (observation?.elements ?? []).find((element) => (element.states ?? []).includes("focused"))
    if (!focused || focused.id === undefined) return undefined
    if (focused.id === elementId) return undefined
    const byId = new Map((observation?.elements ?? []).flatMap((element) => (element.id === undefined ? [] : [[element.id, element] as const])))
    let current = focused
    let guard = 0
    while (current.parentId !== undefined && guard < 24) {
      if (current.parentId === elementId) return undefined
      const parent = byId.get(current.parentId)
      if (parent === undefined) break
      current = parent
      guard += 1
    }
    const label = focused.name ?? focused.text ?? focused.id ?? "another element"
    return `Keyboard focus is on ${focused.role ?? "element"} "${label}", not the requested target.`
  }

  function boundsWarning(
    element: UIElement,
    observation: Observation,
    point: { x: number; y: number },
  ): string | undefined {
    const window = resolveOwningWindow(element, observation)
    const bounds = window?.bounds
    if (bounds === undefined) return undefined
    const inside =
      point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height
    if (inside) return undefined
    return `The control reports bounds outside its window (click point ${Math.round(point.x)},${Math.round(point.y)} vs window ${Math.round(bounds.x)},${Math.round(bounds.y)} ${Math.round(bounds.width)}x${Math.round(bounds.height)}); the click may land in the wrong place. Re-observe before trusting coordinates.`
  }

  // Activate the owning window and CONFIRM it. An unfocused window silently
  // swallows clicks on X11/KDE, so activation is fire-and-forget would let the
  // click land in whatever window really has focus. Returns the window name when
  // the window is still not focused after activation, so the caller can report
  // it instead of pretending the click was aimed correctly.
  async function ensureWindowFocused(
    element: UIElement,
    observation: Observation,
  ): Promise<string | undefined> {
    const window = resolveOwningWindow(element, observation)
    if (!window) return undefined
    if ((window.states ?? []).includes("focused")) return undefined
    const windowId = windowIdOf(window.id)
    if (windowId === undefined) return undefined
    await host.activateWindowId(windowId).catch(() => undefined)
    // The caller's observation predates the activation, so re-read rather than
    // trusting the stale "focused" flag from it.
    const refreshed = await host.observe().catch(() => undefined)
    const current = refreshed === undefined ? window : resolveOwningWindow(element, refreshed) ?? window
    if ((current.states ?? []).includes("focused")) return undefined
    return current.name ?? current.id ?? "the target window"
  }

  async function globalFocusWarning(action: ComputerAction): Promise<string | undefined> {
    const expected = action.metadata?.windowId
    if (typeof expected !== "string" || expected.length === 0) return undefined
    const active = await host.activeWindowId().catch(() => undefined)
    if (active === undefined || active.toLowerCase() === expected.toLowerCase()) return undefined
    return `The active window is ${active}, not the requested window ${expected}; input may go to the wrong window.`
  }

  async function occlusionWarning(element: UIElement, observation: Observation): Promise<string | undefined> {
    const windowId = windowIdOf(resolveOwningWindow(element, observation)?.id)
    if (windowId === undefined) return undefined
    const pointer = await host.pointerWindow().catch(() => undefined)
    if (pointer === undefined || pointer.window.toLowerCase() === windowId.toLowerCase()) return undefined
    return `The click point is covered by window ${pointer.window}; bring the target window forward first.`
  }

  async function decorate(result: ActionResult, element: UIElement): Promise<ActionResult> {
    const bounds = element.bounds
    return {
      ...result,
      metadata: {
        ...(typeof result.metadata === "object" ? result.metadata : {}),
        target: {
          role: element.role ?? "unknown",
          name: element.name ?? element.id ?? "element",
          ...(bounds === undefined
            ? {}
            : {
                bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
                center: { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) },
              }),
        },
      },
    }
  }

  const revalidateTarget = async (reference: ElementReference): Promise<HostRevalidation> => {
    const id = reference.elementId ?? reference.id
    if (!id) return { valid: false, reason: "The reference has no element identifier." }
    // Re-resolution is the authoritative check: observe the computer again and require the target
    // to still be present. The caller's observation id is historical context, not a freshness gate,
    // because acting always produces a newer observation than the one the caller last saw.
    // Drop any cached observation first; a 350ms-old tree can still contain a just-closed target.
    host.invalidateObservation()
    const observation = await host.observe()
    const element = observation.elements?.find((candidate) => candidate.id === id)
    if (!element) return { valid: false, reason: `Element ${id} is not present in the current observation.` }
    if (reference.role !== undefined && element.role !== reference.role) {
      return { valid: false, reason: `Element ${id} is now ${element.role ?? "unknown"}, not ${reference.role}.` }
    }
    return {
      valid: true,
      reference: {
        kind: "element",
        elementId: id,
        ...(observation.id === undefined ? {} : { observationId: observation.id }),
        ...(element.role === undefined ? {} : { role: element.role }),
      },
    }
  }

  return {
    id: host.id,
    backend: host.backend,
    get capabilities() {
      return withInputPermission(host.capabilities())
    },
    getInfo: async (): Promise<ComputerInfo> => host.info(),
    observe: async (request?: ObservationRequest): Promise<Observation> => {
      const observation = await host.observe(
        request !== undefined && typeof request.applicationId === "string" ? request.applicationId : undefined,
      )
      return observation
    },
    find: async (request: FindRequest): Promise<FindResult> => host.find(request),
    execute,
    ...(host.runCommand === undefined ? {} : { runCommand: (request: CommandRequest) => host.runCommand!(request) }),
    readText: (input) => host.readText(input),
    readClipboard: () => host.readClipboard(),
    writeClipboard: (text) => host.writeClipboard(text),
    ...(host.writeClipboardImage === undefined
      ? {}
      : { writeClipboardImage: (path: string) => host.writeClipboardImage!(path) }),
    pointerPosition: () => host.pointerPosition(),
    hoverPointer: (x, y, holdMs) => host.hoverPointer(x, y, holdMs),
    mouseDown: (button) => host.mouseDown(button),
    mouseUp: (button) => host.mouseUp(button),
    releaseStuckKeys: () => host.releaseStuckKeys(),
    minimizeWindowId: (windowId) => host.minimizeWindowId(windowId),
    restoreWindowId: (windowId) => host.restoreWindowId(windowId),
    grabInput: (reason) => host.grabInput(reason),
    releaseInput: () => host.releaseInput(),
    inputGrabState: () => host.inputGrabState(),
    subscribeInputGrab: (listener) => host.subscribeInputGrab(listener),
    dispose: () => host.dispose(),
    revalidateTarget,
  }
}

export function createHostDriver(host: LinuxHostDriver = new LinuxHostDriver()): HostDriver {
  if (process.platform === "linux") {
    return createCuaHostDriver({ legacy: host, surface: createLegacyHostDriver(host) })
  }
  return createLegacyHostDriver(host)
}
