import { isActionType, isComputerAction, isState } from "../protocol"
import type {
  ActionResult,
  Bounds,
  CapabilityState,
  CapabilitySupport,
  CommandRequest,
  CommandResult,
  ComputerAction,
  ComputerInfo,
  ComputerTarget,
  ElementReference,
  FindMatch,
  FindRequest,
  FindResult,
  JsonValue,
  Metadata,
  Observation,
  ObservationRequest,
  Point,
  ReadAction,
  ScrollAction,
  UIElement,
  Verification,
} from "../protocol"
import type { HostDriver, HostRevalidation } from "../daemon/host-driver"
import { withInputPermission } from "../daemon/host-driver"
import type { InputGrabEvent, InputGrabReleasedBy } from "../daemon/linux"
import { LinuxHostDriver } from "../daemon/linux"
import {
  bindingMatches,
  CuaEngine,
  elementByIdentity,
  elementByRef,
  refIdentity,
  staleBindingMessage,
  windowAsElement,
  windowByIdentity,
} from "./engine"
import { CuaLiveView, type LiveViewOptions } from "./live-view"
import type {
  CuaAction,
  CuaActionResult,
  CuaCapabilities,
  CuaElement,
  CuaFindQuery,
  CuaPlatform,
  CuaSnapshot,
  CuaSnapshotOptions,
  CuaStateDelta,
  CuaWaitCondition,
  CuaWindow,
} from "./types"

// Find must not miss matches that the default observe budget cut off. 10000
// matches the Linux helper's 20000-node walk ceiling (the helper is asked for
// maxElements * 2 nodes) and stays bounded on every platform.
const FIND_SNAPSHOT_ELEMENTS = 10_000

// The observation a resolved ref came from. Every engine action the driver
// issues carries it, so the remote computer can refuse a pair that no longer
// matches instead of rebinding to whatever now shares the ref string.
interface ResolvedCuaTarget {
  readonly element: CuaElement
  readonly snapshot: CuaSnapshot
}

// Platform fallbacks the engine cannot express: pointer/keyboard synthesis,
// clipboard, screenshots, process launch, and input freeze. Linux passes the
// LinuxHostDriver directly; other platforms adapt their own driver to this
// shape so the engine stays platform-neutral.
export interface CuaLegacyFallbacks {
  capabilities(): CapabilitySupport[]
  info(): Promise<ComputerInfo>
  activeWindowId(): Promise<string | undefined>
  captureScreen(): Promise<ActionResult & { path?: string }>
  clickAt(x: number, y: number, button?: number, count?: number, durationMs?: number): Promise<ActionResult>
  movePointer(x: number, y: number, durationMs?: number): Promise<ActionResult>
  sendGlobalKey(keys: string): Promise<ActionResult>
  typeText(text: string): Promise<ActionResult>
  scrollPointer(direction: string, amount: number, x?: number, y?: number, durationMs?: number): Promise<ActionResult>
  dragPointer(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    button?: number,
    durationMs?: number,
  ): Promise<ActionResult>
  hoverPointer(x: number, y: number, holdMs?: number): Promise<ActionResult>
  pointerPosition(): Promise<ActionResult & { x?: number; y?: number; held?: boolean }>
  mouseDown(button?: number): Promise<ActionResult>
  mouseUp(button?: number): Promise<ActionResult>
  releaseStuckKeys(): Promise<ActionResult>
  readText(input: {
    elementId?: string
    application?: string
    limit?: number
  }): Promise<ActionResult & { text?: string; length?: number; hash?: string }>
  readClipboard(): Promise<ActionResult & { text?: string; length?: number; hash?: string }>
  writeClipboard(text: string): Promise<ActionResult>
  writeClipboardImage(path: string): Promise<ActionResult>
  launchApp(app: string): Promise<ActionResult>
  openTarget(target: string): Promise<ActionResult>
  runCommand(request: CommandRequest): Promise<ActionResult & { command?: CommandResult }>
  closeWindowId(windowId: string): Promise<ActionResult>
  minimizeWindowId(windowId: string): Promise<ActionResult>
  restoreWindowId(windowId: string): Promise<ActionResult>
  grabInput(reason?: string): Promise<ActionResult & { frozen?: boolean; supported?: boolean; mode?: string }>
  releaseInput(): Promise<
    ActionResult & { frozen?: boolean; releasedBy?: InputGrabReleasedBy; supported?: boolean; mode?: string }
  >
  inputGrabState(): Promise<
    ActionResult & { frozen?: boolean; supported?: boolean; reason?: string; releasedBy?: InputGrabReleasedBy }
  >
  subscribeInputGrab(listener: (event: InputGrabEvent) => void): () => void
  dispose(): void
}

export interface CuaHostDriverOptions {
  readonly engine?: CuaEngine
  readonly platform?: CuaPlatform
  readonly legacy?: CuaLegacyFallbacks
  readonly surface?: HostDriver
  readonly id?: string
  readonly backend?: string
}

export class CuaHostDriver implements HostDriver {
  readonly id: string
  readonly backend: string
  readonly engine: CuaEngine
  private readonly injectedLegacy: CuaLegacyFallbacks | undefined
  private readonly injectedSurface: HostDriver | undefined
  private legacyDriver: CuaLegacyFallbacks | undefined
  private capabilityPromise: Promise<CuaCapabilities | undefined> | undefined
  private capabilityCache: CuaCapabilities | undefined
  private fallbackCount = 0

  constructor(options: CuaHostDriverOptions = {}) {
    this.engine = options.engine ?? new CuaEngine(options.platform === undefined ? {} : { platform: options.platform })
    this.injectedLegacy = options.legacy
    this.injectedSurface = options.surface
    const identity = legacyIdentity(this.engine.platform)
    this.id = options.id ?? identity.id
    this.backend = options.backend ?? identity.backend
    void this.refreshCapabilities()
  }

  get capabilities(): readonly CapabilitySupport[] {
    return [...withInputPermission(this.legacy().capabilities()), ...cuaCapabilitySupport(this.capabilityCache)]
  }

  // The engine is primary, but when the platform cannot run it (missing
  // accessibility permission, no display) the platform driver keeps the whole
  // surface working instead of reporting an empty observation.
  private async engineUsable(): Promise<boolean> {
    return this.engine.available().catch(() => false)
  }

  async capabilitiesAsync(): Promise<readonly CapabilitySupport[]> {
    await this.refreshCapabilities()
    return this.capabilities
  }

  async getInfo(): Promise<ComputerInfo> {
    await this.refreshCapabilities()
    const info = await this.legacy()
      .info()
      .catch((): ComputerInfo | undefined => undefined)
    const base: ComputerInfo = info ?? {
      id: this.id,
      name: this.id,
      platform: this.engine.platform,
      backend: this.backend,
      connected: true,
    }
    return { ...base, id: this.id, backend: this.backend, capabilities: this.capabilities }
  }

  async observe(request?: ObservationRequest): Promise<Observation> {
    if (!(await this.engineUsable())) return this.injectedSurface?.observe(request) ?? this.fallbackObservation()
    const snapshot = await this.engine
      .snapshot(request?.applicationId === undefined ? {} : { app: request.applicationId })
      .catch(() => undefined)
    if (snapshot === undefined) return this.fallbackObservation()
    return toObservation(snapshot, this.backend)
  }

  async find(request: FindRequest): Promise<FindResult> {
    if (!(await this.engineUsable())) {
      return this.injectedSurface?.find(request) ?? { query: request.query, matches: [] }
    }
    // The default observe budget truncates large apps long before a query like
    // "Documents" appears, so find searches a snapshot sized to the Linux
    // helper's node ceiling instead of the 1000-element default.
    const options: CuaSnapshotOptions = { maxElements: FIND_SNAPSHOT_ELEMENTS }
    const snapshot = await this.engine.snapshot(options).catch(() => undefined)
    const query: CuaFindQuery = {
      text: request.query,
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.role === undefined ? {} : { role: request.role }),
      ...(request.window === undefined ? {} : { window: request.window }),
      ...(request.limit === undefined ? {} : { limit: request.limit }),
    }
    const found = await this.engine.find(query, options).catch(() => [])
    const matches = found.map(
      (element): FindMatch => ({
        element: toUIElement(element, snapshot?.id ?? "cua", this.backend),
        score: 1,
        reference: {
          kind: "element",
          elementId: element.ref,
          ...(snapshot === undefined ? {} : { observationId: snapshot.id, generation: snapshot.generation }),
          ...(element.role.length === 0 ? {} : { role: element.role }),
        },
      }),
    )
    return {
      query: request.query,
      matches,
      results: matches,
      elements: matches.map((match) => match.element),
      references: matches.flatMap((match) => (match.reference === undefined ? [] : [match.reference])),
      ...(snapshot === undefined ? {} : { observation: toObservation(snapshot, this.backend) }),
      metadata: { strategy: "cua-refs" },
    }
  }

  async execute(action: ComputerAction): Promise<ActionResult> {
    // Dismiss carries no target by design, but the protocol guard still
    // requires one; admit it here so the action is not rejected before the
    // engine runs.
    const type = action.type
    if (!isComputerAction(action) && type !== "dismiss") return invalidAction()
    if (!(await this.engineUsable())) {
      return this.injectedSurface?.execute(action) ?? invalidAction()
    }

    if (action.type === "observe") {
      const observation = await this.observe(
        action.applicationId === undefined ? undefined : { applicationId: action.applicationId },
      )
      return { success: true, status: "success", message: "Observation captured.", observation }
    }

    if (action.type === "find") {
      const result = await this.find(action.request)
      return {
        success: true,
        status: "success",
        message: "Find completed.",
        ...(result.observation === undefined ? {} : { observation: result.observation }),
      }
    }

    if (action.type === "screenshot") return this.legacy().captureScreen()

    if (action.type === "read") return this.readAction(action)

    if (action.type === "wait") return this.waitAction(action)

    if (action.type === "copy") {
      const resolved = await this.pointerTargetFor(action)
      if (resolved !== undefined && "stale" in resolved) return resolved.stale
      if (resolved !== undefined) {
        const clicked = await this.legacy().clickAt(resolved.point.x, resolved.point.y)
        if (!clicked.success) return clicked
      }
      return this.withObservation(await this.legacy().sendGlobalKey("ctrl+c"))
    }

    if (action.type === "paste") {
      const resolved = await this.pointerTargetFor(action)
      if (resolved !== undefined && "stale" in resolved) return resolved.stale
      if (resolved !== undefined) {
        const clicked = await this.legacy().clickAt(resolved.point.x, resolved.point.y)
        if (!clicked.success) return clicked
      }
      if (action.text.length > 0) {
        const written = await this.legacy().writeClipboard(action.text)
        if (written.success) {
          const pasted = await this.legacy().sendGlobalKey("ctrl+v")
          if (pasted.success) {
            return this.withObservation({
              ...pasted,
              message: `Pasted ${action.text.length} characters from the clipboard.`,
            })
          }
        }
        return this.withObservation(await this.legacy().typeText(action.text))
      }
      return this.withObservation(await this.legacy().sendGlobalKey("ctrl+v"))
    }

    if (action.type === "dismiss") return this.runCua({ type: "dismiss" })

    if (action.type === "key" || action.type === "keypress") {
      const key = action.type === "key" ? (action.key ?? action.keys) : action.key
      if (typeof key !== "string" || key.length === 0) return unavailable("The key action requires a key.")
      const warning = await this.globalFocusWarning(action)
      return attachWarning(await this.runCua({ type: "key", keys: splitKeys(key) }), "focusWarning", warning)
    }

    if (action.type === "press_keys" || action.type === "press") {
      const warning = await this.globalFocusWarning(action)
      return attachWarning(await this.runCua({ type: "key", keys: splitKeys(action.keys) }), "focusWarning", warning)
    }

    if (action.type === "launch") return this.legacy().launchApp(action.applicationId)
    if (action.type === "open") return this.legacy().openTarget(action.target)
    if (action.type === "close") return this.closeAction(action)

    if (action.type === "scroll") return this.scrollAction(action)
    if (action.type === "move") return this.moveAction(action)
    if (action.type === "drag") return this.dragAction(action)
    if (action.type === "longpress") return unavailable("The longpress action is not supported by this driver.")

    const ref = elementRefOf(action)
    if (ref !== undefined) return this.elementAction(action, ref)

    if (action.type === "type") return this.runCua({ type: "type", text: action.text })

    const point = pointOf(action.target)
    if (
      point !== undefined &&
      (action.type === "click" || action.type === "doubleclick" || action.type === "rightclick")
    ) {
      // The capture only needs a coherent snapshot id and the default budget
      // is enough for pointer delivery; a find-sized walk here was waste.
      const snapshot = await this.engine.snapshot().catch(() => undefined)
      const button =
        action.type === "rightclick" ? "right" : action.type === "click" ? (action.button ?? "left") : "left"
      const count = action.type === "doubleclick" ? 2 : action.type === "click" ? (action.count ?? 1) : 1
      return this.pointerClick(point, button, count, snapshot?.id)
    }

    return unavailable(`Action ${action.type} is not supported by this driver.`)
  }

  /**
   * Opens a metered screenshot stream for this computer.
   *
   * Streaming is `live_view`; a single `screenshot` action is not, because it
   * is one capture inside one action. The lease inside the returned session
   * holds the single decision, so per-frame capture never calls the control
   * plane. Throws EntitlementRefusedError when the plan does not include it.
   */
  openLiveView(options: LiveViewOptions = {}): Promise<CuaLiveView> {
    return CuaLiveView.open(() => this.legacy().captureScreen(), options)
  }

  async revalidateTarget(reference: ElementReference): Promise<HostRevalidation> {
    if (!(await this.engineUsable())) {
      return (
        this.injectedSurface?.revalidateTarget?.(reference) ??
        Promise.resolve({ valid: false, reason: "The accessibility engine is unavailable." })
      )
    }
    const id = reference.elementId ?? reference.id
    if (!id) return { valid: false, reason: "The reference has no element identifier." }
    // Revalidation translates a historical reference into the fresh snapshot:
    // presence plus role stability is the validity test. The fresh
    // observationId/generation is returned so callers can bind the next act
    // to this generation; act-path enforcement (not revalidation) refuses
    // mismatched generations as target_stale.
    this.engine.invalidate()
    const snapshot = await this.engine.snapshot({ maxElements: FIND_SNAPSHOT_ELEMENTS }).catch(() => undefined)
    if (snapshot === undefined) {
      return { valid: false, reason: `Element ${id} could not be checked because no snapshot is available.` }
    }
    // A ref is scoped to the observation that minted it, so the historical
    // string is matched on its identity: the fresh observation minted new
    // scoped refs for the same elements, and the reference returned below is
    // the one that works now.
    const window = windowByIdentity(snapshot, id)
    const element = elementByIdentity(snapshot, id) ?? (window === undefined ? undefined : windowAsElement(window))
    if (element === undefined)
      return { valid: false, reason: `Element ${refIdentity(id)} is not present in the current observation.` }
    if (reference.role !== undefined && element.role !== reference.role) {
      return {
        valid: false,
        reason: `Element ${refIdentity(id)} is now ${element.role}, not ${reference.role}.`,
      }
    }
    return {
      valid: true,
      reference: {
        kind: "element",
        elementId: element.ref,
        observationId: snapshot.id,
        generation: snapshot.generation,
        ...(element.role.length === 0 ? {} : { role: element.role }),
      },
    }
  }

  readText(input: {
    elementId?: string
    application?: string
    limit?: number
  }): Promise<ActionResult & { text?: string; length?: number; hash?: string }> {
    if (input.elementId !== undefined) return this.readTextFromSnapshot(input.elementId, input.limit)
    return this.legacy().readText(input)
  }

  readClipboard(): Promise<ActionResult & { text?: string; length?: number; hash?: string }> {
    return this.legacy().readClipboard()
  }

  writeClipboard(text: string): Promise<ActionResult> {
    return this.legacy().writeClipboard(text)
  }

  writeClipboardImage(path: string): Promise<ActionResult> {
    return this.legacy().writeClipboardImage(path)
  }

  runCommand(request: CommandRequest): Promise<ActionResult & { command?: CommandResult }> {
    return this.legacy().runCommand(request)
  }

  pointerPosition(): Promise<ActionResult & { x?: number; y?: number; held?: boolean }> {
    return this.legacy().pointerPosition()
  }

  hoverPointer(x: number, y: number, holdMs?: number): Promise<ActionResult> {
    return this.legacy().hoverPointer(x, y, holdMs)
  }

  mouseDown(button?: number): Promise<ActionResult> {
    return this.legacy().mouseDown(button)
  }

  mouseUp(button?: number): Promise<ActionResult> {
    return this.legacy().mouseUp(button)
  }

  releaseStuckKeys(): Promise<ActionResult> {
    return this.legacy().releaseStuckKeys()
  }

  minimizeWindowId(windowId: string): Promise<ActionResult> {
    return this.windowAction(windowId, "minimize")
  }

  restoreWindowId(windowId: string): Promise<ActionResult> {
    return this.windowAction(windowId, "restore")
  }

  grabInput(reason?: string): Promise<ActionResult & { frozen?: boolean; supported?: boolean; mode?: string }> {
    return this.legacy().grabInput(reason)
  }

  releaseInput(): Promise<
    ActionResult & { frozen?: boolean; releasedBy?: InputGrabReleasedBy; supported?: boolean; mode?: string }
  > {
    return this.legacy().releaseInput()
  }

  inputGrabState(): Promise<
    ActionResult & { frozen?: boolean; supported?: boolean; reason?: string; releasedBy?: InputGrabReleasedBy }
  > {
    return this.legacy().inputGrabState()
  }

  subscribeInputGrab(listener: (event: InputGrabEvent) => void): () => void {
    return this.legacy().subscribeInputGrab(listener)
  }

  dispose(): void {
    void this.engine.dispose().catch(() => undefined)
    this.legacyDriver?.dispose()
  }

  private legacy(): CuaLegacyFallbacks {
    if (this.legacyDriver === undefined) {
      this.legacyDriver = this.injectedLegacy ?? new LinuxHostDriver()
    }
    return this.legacyDriver
  }

  private async resolveElement(ref: string): Promise<ResolvedCuaTarget | undefined> {
    // Act must resolve the ref against the observation that minted it, so the
    // default-budget observation is tried first: a ref taken from an observe is
    // still bound to it. Only a ref that budget truncated away pays for the
    // find-sized walk, and that walk reuses the same observation rather than
    // re-reading the desktop under a different generation.
    const cached = await this.engine.snapshot().catch(() => undefined)
    const resolved = this.targetIn(ref, cached)
    if (resolved !== undefined) return resolved
    // Act and find share one snapshot budget so a ref returned by find is
    // still present when the act path resolves it. A smaller act budget would
    // truncate the valid ref away and refuse it as stale.
    const snapshot = await this.engine.snapshot({ maxElements: FIND_SNAPSHOT_ELEMENTS }).catch(() => undefined)
    if (snapshot === undefined) return undefined
    const element = elementByRef(snapshot, ref)
    if (element !== undefined) return { element, snapshot }
    const window = snapshot.windows.find((candidate) => candidate.ref === ref)
    return window === undefined ? undefined : { element: windowAsElement(window), snapshot }
  }

  private targetIn(ref: string, snapshot: CuaSnapshot | undefined): ResolvedCuaTarget | undefined {
    if (snapshot === undefined) return undefined
    const element = elementByRef(snapshot, ref)
    if (element !== undefined) return { element, snapshot }
    const window = snapshot.windows.find((candidate) => candidate.ref === ref)
    return window === undefined ? undefined : { element: windowAsElement(window), snapshot }
  }

  private targetByIdentityIn(ref: string, snapshot: CuaSnapshot | undefined): ResolvedCuaTarget | undefined {
    if (snapshot === undefined) return undefined
    const element = elementByIdentity(snapshot, ref)
    if (element !== undefined) return { element, snapshot }
    const window = windowByIdentity(snapshot, ref)
    return window === undefined ? undefined : { element: windowAsElement(window), snapshot }
  }

  private async resolveBoundElement(
    action: ComputerAction,
    ref: string,
  ): Promise<ResolvedCuaTarget | { stale: ActionResult }> {
    const current = await this.resolveElement(ref)
    if (current === undefined) return { stale: stale(`Target ${ref} is not present in the current observation.`) }
    const mismatch = bindingMismatch(action, current.snapshot)
    if (mismatch !== undefined) return { stale: staleBinding(ref, mismatch, current.snapshot) }
    return current
  }

  // Re-resolving a ref the driver already holds: an engine action's own
  // post-action read makes the previous observation stale, so the next step in
  // the same protocol action retargets the same element — by identity, because
  // the new observation minted new scoped refs — and binds to that observation.
  private async retargetElement(ref: string): Promise<ResolvedCuaTarget | { stale: ActionResult }> {
    const cached = await this.engine.snapshot().catch(() => undefined)
    const found = this.targetByIdentityIn(ref, cached)
    if (found !== undefined) return found
    // Act and find share one snapshot budget, so a ref the default budget
    // truncated away is still reachable through the find-sized walk.
    const snapshot = await this.engine.snapshot({ maxElements: FIND_SNAPSHOT_ELEMENTS }).catch(() => undefined)
    const widened = this.targetByIdentityIn(ref, snapshot)
    if (widened !== undefined) return widened
    return { stale: stale(`Target ${refIdentity(ref)} is not present in the current observation.`) }
  }

  // undefined means "no element target": the caller may fall back to the global
  // (targetless) path. A supplied ref that cannot be resolved, or whose
  // generation-scoped observation binding no longer matches, is a refusal
  // instead — copy/paste must never silently degrade from "click this element"
// to a global clipboard keystroke aimed at whatever happens to be focused.
  private async elementCenterFor(
    action: ComputerAction,
  ): Promise<{ point: Point } | { stale: ActionResult } | undefined> {
    const ref = elementRefOf(action)
    if (ref === undefined) return undefined
    const current = await this.resolveElement(ref)
    if (current === undefined) return { stale: stale(`Target ${ref} is not present in the current observation.`) }
    const mismatch = bindingMismatch(action, current.snapshot)
    if (mismatch !== undefined) return { stale: staleBinding(ref, mismatch, current.snapshot) }
    if (current.element.bounds === undefined) {
      return { stale: stale(`Target ${ref} has no bounds in the current observation, so it cannot be aimed at.`) }
    }
    return { point: centerOf(current.element.bounds) }
  }

  // The point a pointer action acts on: an explicit point wins, otherwise the
  // element ref's center. Refuses an unresolvable or generation-mismatched
  // element target; returns undefined only for a targetless action.
  private async pointerTargetFor(
    action: ComputerAction,
  ): Promise<{ point: Point } | { stale: ActionResult } | undefined> {
    const point = pointOf(action.target)
    if (point !== undefined) return { point }
    return this.elementCenterFor(action)
  }

  private async pointForTarget(target: ComputerTarget): Promise<Point | undefined> {
    if (target.kind === "point") return { x: target.x, y: target.y }
    if (target.kind !== "element") return undefined
    const current = await this.resolveElement(target.elementId)
    if (current?.element.bounds === undefined) return undefined
    if (bindingMismatch({ target }, current.snapshot) !== undefined) return undefined
    return centerOf(current.element.bounds)
  }

  private async elementAction(action: ComputerAction, ref: string): Promise<ActionResult> {
    const bound = await this.resolveBoundElement(action, ref)
    if ("stale" in bound) return bound.stale
    const current = bound
    if (action.type === "type") {
      // NO silent type→set_value: typing is keyboard input after focus. An
      // explicit setvalue action uses the background set_value path.
      const focused = await this.runCua({ type: "focus", ref }, current)
      if (!focused.success) return focused
      // Focus is one action and its post-action read is a new observation, so
      // the text goes to the ref that observation minted rather than the one
      // focus consumed.
      const retargeted = await this.retargetElement(ref)
      if ("stale" in retargeted) return retargeted.stale
      return this.runCua({ type: "type", text: action.text }, retargeted)
    }

    if (action.type === "setvalue") {
      return this.runCua({ type: "set_value", ref, value: jsonText(action.value) }, current)
    }

    if (action.type === "focus") {
      const isWindow =
        current.element.role === "window" || current.snapshot.windows.some((window) => window.ref === ref)
      return this.runCua(isWindow ? { type: "window", action: "focus", ref } : { type: "focus", ref }, current)
    }

    if (action.type === "click" || action.type === "doubleclick" || action.type === "rightclick") {
      // NO silent click→first-action: only an explicitly matched backend
      // action may become an invoke. An unmatched click is pointer input.
      const candidate = matchBackendAction(current.element.actions, action.type)
      if (candidate !== undefined) {
        const invoked = await this.runCua({ type: "invoke", ref, action: candidate }, current)
        if (invoked.success) return invoked
      }
      const point = aimPoint(current.element)
      if (point === undefined) {
        return unavailable(`Element ${ref} exposes no invokable action and has no bounds.`)
      }
      const button =
        action.type === "rightclick" ? "right" : action.type === "click" ? (action.button ?? "left") : "left"
      const count = action.type === "doubleclick" ? 2 : action.type === "click" ? (action.count ?? 1) : 1
      return this.pointerClick(point, button, count, current.snapshot.id, current)
    }

    if (action.type === "toggle") {
      const candidate = current.element.actions.find((name) =>
        ["toggle", "check", "click", "press", "activate"].some((known) => known === name.toLowerCase()),
      )
      const invoked = await this.runCua(
        { type: "invoke", ref, ...(candidate === undefined ? {} : { action: candidate }) },
        current,
      )
      if (invoked.success) return invoked
      const point = aimPoint(current.element)
      if (point === undefined) {
        return unavailable(`Element ${ref} exposes no invokable action and has no bounds.`)
      }
      return this.pointerClick(point, "left", 1, current.snapshot.id, current)
    }

    if (action.type === "select") {
      if (action.value !== undefined) {
        return this.runCua({ type: "set_value", ref, value: jsonText(action.value) }, current)
      }
      return this.runCua({ type: "select", ref }, current)
    }

    if (action.type === "expand") {
      return this.runCua({ type: "expand", ref }, current)
    }

    if (action.type === "collapse") {
      return this.runCua({ type: "collapse", ref }, current)
    }

    if (action.type === "scroll_into_view") {
      return this.runCua({ type: "scroll_into_view", ref }, current)
    }

    if (action.type === "increment") {
      return this.runCua({ type: "increment", ref }, current)
    }

    if (action.type === "decrement") {
      return this.runCua({ type: "decrement", ref }, current)
    }

    return unavailable(`Action ${action.type} is not supported for element targets by this driver.`)
  }

  private async scrollAction(action: ScrollAction): Promise<ActionResult> {
    const direction = action.direction ?? (action.deltaY !== undefined && action.deltaY < 0 ? "up" : "down")
    const amount = action.amount ?? Math.max(1, Math.min(10, Math.round(Math.abs(action.deltaY ?? 3))))
    const ref = elementRefOf(action)
    if (ref !== undefined) {
      const bound = await this.resolveBoundElement(action, ref)
      if ("stale" in bound) return bound.stale
      return this.runCua({ type: "scroll", direction, amount, ref }, bound)
    }
    const resolved = await this.pointerTargetFor(action)
    if (resolved !== undefined && "stale" in resolved) return resolved.stale
    if (resolved === undefined) return unavailable("A scroll action requires a point or an element with bounds.")
    return this.withObservation(
      await this.legacy().scrollPointer(direction, amount, resolved.point.x, resolved.point.y, durationOf(action, 200)),
    )
  }

  private async moveAction(action: ComputerAction): Promise<ActionResult> {
    const resolved = await this.pointerTargetFor(action)
    if (resolved !== undefined && "stale" in resolved) return resolved.stale
    if (resolved === undefined) return unavailable("A move action requires a point or an element with bounds.")
    return this.withObservation(
      await this.legacy().movePointer(resolved.point.x, resolved.point.y, durationOf(action, 240)),
    )
  }

  private async dragAction(action: Extract<ComputerAction, { type: "drag" }>): Promise<ActionResult> {
    const from = await this.pointForTarget(action.from)
    const to = await this.pointForTarget(action.to)
    if (from === undefined || to === undefined) return unavailable("A drag action requires two resolvable targets.")
    const snapshot = await this.engine.snapshot().catch(() => undefined)
    const dragged = await this.runCua({
      type: "drag",
      from,
      to,
      ...(snapshot === undefined ? {} : { captureId: snapshot.id }),
    })
    if (dragged.success) return dragged
    const moved = await this.legacy().movePointer(from.x, from.y, durationOf(action, 200))
    if (!moved.success) return dragged
    return this.withObservation(
      unverifiedLegacy(
        await this.legacy().dragPointer(
          from.x,
          from.y,
          to.x,
          to.y,
          buttonNumber(action.button),
          durationOf(action, 600),
        ),
        "legacy-drag",
        "The drag was synthesized as raw pointer input; only a post-action read can confirm where the pointer landed.",
      ),
    )
  }

  private async closeAction(action: ComputerAction): Promise<ActionResult> {
    const ref = elementRefOf(action)
    if (ref !== undefined) {
      const current = await this.resolveElement(ref)
      if (current !== undefined) {
        const mismatch = bindingMismatch(action, current.snapshot)
        if (mismatch !== undefined) return staleBinding(ref, mismatch, current.snapshot)
      }
      const isWindow =
        current !== undefined &&
        (current.element.role === "window" || current.snapshot.windows.some((window) => window.ref === ref))
      if (isWindow) {
        return this.runCua({ type: "window", action: "close", ref }, current)
      }
    }
    const windowId = ref === undefined ? undefined : x11WindowIdOf(ref)
    if (windowId !== undefined) {
      return this.withObservation(
        unverifiedLegacy(
          await this.legacy().closeWindowId(windowId),
          "legacy-window",
          "The window was closed through the raw X11 path; only a post-action read can confirm the window is gone.",
        ),
      )
    }
    return unavailable("Closing is only supported for a window target on this computer.")
  }

  private async windowAction(windowId: string, action: "minimize" | "restore"): Promise<ActionResult> {
    // Window records survive element capping, so the default budget finds the
    // window without paying for a find-sized element walk.
    const snapshot = await this.engine.snapshot().catch(() => undefined)
    const window =
      snapshot === undefined
        ? undefined
        : snapshot.windows.find((candidate) => candidate.ref === windowId || candidate.backendRef === windowId)
    if (window === undefined || snapshot === undefined) {
      const legacy =
        action === "minimize"
          ? await this.legacy().minimizeWindowId(windowId)
          : await this.legacy().restoreWindowId(windowId)
      return unverifiedLegacy(
        legacy,
        "legacy-window",
        `The window was ${action === "minimize" ? "minimized" : "restored"} through the raw X11 path; only a post-action read can confirm the window's state changed.`,
      )
    }
    return this.runCua({ type: "window", action, ref: window.ref }, { element: windowAsElement(window), snapshot })
  }

  private async readAction(
    action: ReadAction,
  ): Promise<ActionResult & { text?: string; length?: number; hash?: string }> {
    if (action.target?.kind === "element") return this.readTextFromSnapshot(action.target.elementId)
    if (action.target?.kind === "application") {
      return this.legacy().readText({ application: action.target.applicationId })
    }
    const observation = await this.observe()
    return { success: true, status: "success", message: "Observation captured.", observation }
  }

  private async readTextFromSnapshot(
    ref: string,
    limit?: number,
  ): Promise<ActionResult & { text?: string; length?: number; hash?: string }> {
    const current = await this.resolveElement(ref)
    if (current === undefined) return stale(`Target ${ref} is not present in the current observation.`)
    // A window ref has no text of its own; reading it returns the window's
    // accessibility subtree so a window read is not just the title.
    const window = current.snapshot.windows.find((candidate) => candidate.ref === ref)
    const text =
      window === undefined
        ? (current.element.text ?? current.element.value ?? current.element.name ?? "")
        : windowSubtreeText(current.snapshot, window)
    const limited = limit === undefined ? text : text.slice(0, limit)
    return {
      success: true,
      status: "success",
      message: `Read ${limited.length} characters.`,
      text: limited,
      length: limited.length,
      hash: hashText(limited),
    }
  }

  private async waitAction(action: Extract<ComputerAction, { type: "wait" }>): Promise<ActionResult> {
    const condition = typeof action.condition === "string" ? action.condition.trim() : ""
    if (condition.length > 0) {
      const waited = await this.engine.waitFor(parseWaitCondition(condition, action.timeoutMs)).catch(() => undefined)
      if (waited === undefined) return unavailable("The wait condition could not be evaluated.")
      const observation = await this.observation()
      return {
        success: waited.ok,
        status: waited.ok ? "success" : "failed",
        message: waited.ok
          ? `Condition met after ${waited.waitedMs}ms.`
          : `Condition was not met after ${waited.waitedMs}ms.`,
        ...(observation === undefined ? {} : { observation }),
      }
    }
    const requested = typeof action.ms === "number" && action.ms > 0 ? action.ms : 800
    const capped = Math.min(requested, 30000)
    await new Promise((resolve) => setTimeout(resolve, capped))
    const observation = await this.observation()
    return {
      success: true,
      status: "success",
      message: `Waited ${capped}ms.`,
      ...(observation === undefined ? {} : { observation }),
    }
  }

  private async globalFocusWarning(action: ComputerAction): Promise<string | undefined> {
    const expected = action.metadata?.windowId
    if (typeof expected !== "string" || expected.length === 0) return undefined
    const active = await this.legacy()
      .activeWindowId()
      .catch(() => undefined)
    if (active === undefined || active.toLowerCase() === expected.toLowerCase()) return undefined
    return `The active window is ${active}, not the requested window ${expected}; input may go to the wrong window.`
  }

  private async runCua(action: CuaAction, target?: ResolvedCuaTarget): Promise<ActionResult> {
    // The observation pair travels with the action: the remote computer refuses
    // a ref that no longer belongs to the observation it was minted in, instead
    // of rebinding to whatever now occupies the same string.
    const bound =
      target === undefined
        ? action
        : {
            ...action,
            observationId: target.snapshot.id,
            generation: target.snapshot.generation,
          }
    const result = await this.engine.execute(bound)
    const mapped = toActionResult(result, target?.element)
    if (!mapped.success) return mapped
    return this.withObservation(mapped)
  }

  private async pointerClick(
    point: Point,
    button: "left" | "right" | "middle",
    count: number,
    captureId?: string,
    target?: ResolvedCuaTarget,
  ): Promise<ActionResult> {
    return this.runCua(
      { type: "click", point, button, count, ...(captureId === undefined ? {} : { captureId }) },
      target,
    )
  }

  private async observation(): Promise<Observation | undefined> {
    return this.engine.snapshot().then(
      (snapshot) => toObservation(snapshot, this.backend),
      () => undefined,
    )
  }

  private async withObservation(result: ActionResult): Promise<ActionResult> {
    if (!result.success) return result
    // engine.execute already refreshed the snapshot after the action; reusing
    // it avoids a second full walk and keeps the capture id coherent.
    const snapshot = this.engine.latestSnapshot()
    if (snapshot !== undefined) return { ...result, observation: toObservation(snapshot, this.backend) }
    const observation = await this.observation()
    return observation === undefined ? result : { ...result, observation }
  }

  private fallbackObservation(): Observation {
    this.fallbackCount += 1
    return {
      id: `cua-unavailable-${this.fallbackCount}`,
      timestamp: Date.now(),
      source: "accessibility",
      backend: this.backend,
      elements: [],
      warnings: ["The Cua backend could not produce a snapshot; no accessibility data is available."],
      capabilities: { accessibility: "unavailable" },
      // Distinguish "snapshot failed" from a genuinely blank desktop so callers
      // do not treat an empty element list as ground truth.
      metadata: { error: "snapshot_failed" },
    }
  }

  private refreshCapabilities(): Promise<CuaCapabilities | undefined> {
    if (this.capabilityPromise === undefined) {
      this.capabilityPromise = this.engine.capabilities().then(
        (capabilities) => {
          this.capabilityCache = capabilities
          return capabilities
        },
        () => {
          this.capabilityPromise = undefined
          return undefined
        },
      )
    }
    return this.capabilityPromise
  }
}

export function createCuaHostDriver(options: CuaHostDriverOptions = {}): CuaHostDriver {
  return new CuaHostDriver(options)
}

function legacyIdentity(platform: CuaPlatform): { id: string; backend: string } {
  if (platform === "darwin") return { id: "darwin-host", backend: "macos-ax" }
  if (platform === "win32") return { id: "windows-host", backend: "windows-uia" }
  return { id: "linux-host", backend: "linux-at-spi" }
}

function cuaCapabilitySupport(capabilities: CuaCapabilities | undefined): CapabilitySupport[] {
  return [
    {
      capability: "cua_snapshot",
      status: capabilityState(capabilities?.snapshot),
      reason: "Structured accessibility snapshots taken through the Cua engine.",
    },
    {
      capability: "cua_refs",
      status: capabilityState(capabilities?.refs),
      reason: "Elements carry stable refs that can be resolved and revalidated.",
    },
    {
      capability: "cua_background",
      status: capabilityState(capabilities?.backgroundActions),
      reason: "Semantic actions are delivered in the background without stealing focus.",
    },
    {
      capability: "cua_rich_actions",
      status: capabilityState(capabilities?.semanticActions),
      reason: "Rich semantic actions such as set_value, select, expand, and invoke.",
    },
    {
      capability: "cua_wait",
      status: capabilityState(capabilities?.waitFor),
      reason: "Condition-based waits resolved against fresh snapshots.",
    },
  ]
}

function capabilityState(value: boolean | undefined): CapabilityState {
  if (value === undefined) return "unknown"
  return value ? "available" : "unavailable"
}

function toObservation(snapshot: CuaSnapshot, backend: string): Observation {
  const windows = snapshot.windows.map((window) => toWindowUIElement(window, snapshot.id, backend))
  const elements = snapshot.elements.map((element) => toUIElement(element, snapshot.id, backend))
  return {
    id: snapshot.id,
    timestamp: snapshot.takenAt,
    capturedAt: snapshot.takenAt,
    source: "accessibility",
    backend,
    elements: [...windows, ...elements],
    ...(snapshot.screen === undefined ? {} : { screen: snapshot.screen }),
    warnings: [...snapshot.warnings],
    capabilities: {
      // Capabilities follow the snapshot's declared accessibility state; a
      // warning-bearing read is never advertised as fully available.
      accessibility:
        snapshot.accessibility ??
        (snapshot.warnings.length === 0 && (snapshot.windows.length > 0 || snapshot.elements.length > 0)
          ? "available"
          : "degraded"),
      keyboard: "degraded",
      pointer: "degraded",
      direct_ui_control: "degraded",
    },
    metadata: {
      generation: snapshot.generation,
      platform: snapshot.platform,
      truncated: snapshot.truncated,
      windows: snapshot.windows.length,
      ...(snapshot.focusedRef === undefined ? {} : { focusedRef: snapshot.focusedRef }),
    },
  }
}

function toUIElement(element: CuaElement, observationId: string, backend: string): UIElement {
  return {
    id: element.ref,
    role: element.role,
    name: element.name,
    ...(element.description === undefined ? {} : { description: element.description }),
    ...(element.text === undefined ? {} : { text: element.text }),
    ...(element.value === undefined ? {} : { value: element.value }),
    ...(element.bounds === undefined ? {} : { bounds: element.bounds }),
    states: element.states.flatMap((state) => (isState(state) ? [state] : [])),
    actions: element.actions.flatMap((action) => (isActionType(action) ? [action] : [])),
    ...(element.parentRef === undefined ? {} : { parentId: element.parentRef }),
    source: "accessibility",
    backend,
    reference: {
      kind: "element",
      elementId: element.ref,
      observationId,
      generation: element.generation,
      source: "accessibility",
      backend,
    },
    provenance: { source: "application", trust: "untrusted", authority: "none", backend },
    metadata: {
      backendRef: element.backendRef,
      editable: element.editable,
      enabled: element.enabled,
      focused: element.focused,
      generation: element.generation,
      ...(element.windowRef === undefined ? {} : { windowRef: element.windowRef }),
      ...(element.application === undefined ? {} : { application: element.application, app: element.application }),
      ...(element.attributes === undefined ? {} : { attributes: element.attributes }),
    },
  }
}

function toWindowUIElement(window: CuaWindow, observationId: string, backend: string): UIElement {
  return {
    id: window.ref,
    role: "window",
    name: window.title,
    ...(window.bounds === undefined ? {} : { bounds: window.bounds }),
    states: window.focused ? ["focused"] : [],
    actions: [],
    source: "accessibility",
    backend,
    reference: {
      kind: "element",
      elementId: window.ref,
      observationId,
      generation: window.generation,
      source: "accessibility",
      backend,
    },
    provenance: { source: "application", trust: "untrusted", authority: "none", backend },
    metadata: {
      app: window.app,
      application: window.app,
      backendRef: window.backendRef,
      generation: window.generation,
    },
  }
}

function toActionResult(result: CuaActionResult, target?: CuaElement): ActionResult {
  const verification: Verification = {
    status: result.ok ? (result.verified ? "verified" : "unverified") : "failed",
    verified: result.ok && result.verified,
    ok: result.ok,
    method: "cua-snapshot",
    message: result.message,
    ...(result.stateDelta === undefined
      ? {}
      : { evidence: [{ kind: "cua-state-delta", value: stateDeltaJson(result.stateDelta) }] }),
  }
  const metadata: Metadata = {
    delivery: result.delivery,
    generation: result.generation,
    ...(result.stateDelta === undefined ? {} : { stateDelta: stateDeltaJson(result.stateDelta) }),
    ...(result.warnings === undefined || result.warnings.length === 0 ? {} : { warnings: [...result.warnings] }),
    ...(target === undefined ? {} : { target: targetJson(target) }),
  }
  return {
    success: result.ok,
    status: result.ok ? "success" : result.delivery === "refused" ? "rejected" : "failed",
    message: result.message,
    ...(result.error === undefined
      ? {}
      : { error: { code: result.error.code, message: result.error.message, retryable: result.error.retryable } }),
    verification,
    metadata,
  }
}

function stateDeltaJson(delta: CuaStateDelta): Metadata {
  return {
    ...(delta.focusedRef === undefined ? {} : { focusedRef: delta.focusedRef }),
    ...(delta.addedRefs === undefined ? {} : { addedRefs: [...delta.addedRefs] }),
    ...(delta.removedRefs === undefined ? {} : { removedRefs: [...delta.removedRefs] }),
    ...(delta.changedRefs === undefined ? {} : { changedRefs: [...delta.changedRefs] }),
  }
}

function targetJson(element: CuaElement): Metadata {
  const bounds = element.bounds
  return {
    ref: element.ref,
    role: element.role,
    name: element.name,
    ...(bounds === undefined
      ? {}
      : {
          bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
          center: { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) },
        }),
  }
}

// Every element carries its windowRef, so a window read does not need a tree
// walk; duplicates are dropped because the same label often appears on both a
// container and its cell.
function windowSubtreeText(snapshot: CuaSnapshot, window: CuaWindow): string {
  const names = snapshot.elements
    .filter((element) => element.windowRef === window.ref)
    .flatMap((element) => [element.name, element.text, element.value])
  return [...new Set([window.title, ...names])]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("\n")
}

function invalidAction(): ActionResult {
  return {
    success: false,
    status: "failed",
    message: "The action is not a valid computer action.",
    error: { code: "invalid_action", message: "The action is not a valid computer action.", retryable: false },
  }
}

function stale(message: string): ActionResult {
  return {
    success: false,
    status: "rejected",
    message,
    error: { code: "target_stale", message, retryable: true },
  }
}

// A legacy pointer/window fallback synthesizes input the engine never observed,
// so its raw ActionResult carries no verification at all. Callers upstream used
// to read that absence as proof, so the reason is stated explicitly instead:
// only a post-action read (the server's own observation diff or window-state
// readback) can turn these into a verified outcome.
function unverifiedLegacy(result: ActionResult, method: string, message: string): ActionResult {
  if (result.verification !== undefined) return result
  return {
    ...result,
    verification: { status: result.success ? "unverified" : "failed", method, message },
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

function attachWarning(result: ActionResult, key: string, warning: string | undefined): ActionResult {
  if (warning === undefined) return result
  return { ...result, metadata: { ...(result.metadata ?? {}), [key]: warning } }
}

function centerOf(bounds: Bounds): Point {
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

function aimPoint(element: CuaElement): Point | undefined {
  const bounds = element.bounds
  if (bounds === undefined) return undefined
  const role = element.role.toLowerCase()
  const x = TEXT_LIKE_ROLES.has(role)
    ? bounds.x + Math.min(28, Math.max(6, bounds.width * 0.08))
    : bounds.x + bounds.width / 2
  return { x, y: bounds.y + bounds.height / 2 }
}

const CLICK_ACTIONS = ["click", "press", "activate"]
const DOUBLE_CLICK_ACTIONS = ["double-click", "doubleclick", "double click"]
const CONTEXT_CLICK_ACTIONS = ["context-click", "context click", "show-menu", "show menu", "menu"]

function matchBackendAction(
  actions: readonly string[],
  type: "click" | "doubleclick" | "rightclick",
): string | undefined {
  const candidates =
    type === "doubleclick" ? DOUBLE_CLICK_ACTIONS : type === "rightclick" ? CONTEXT_CLICK_ACTIONS : CLICK_ACTIONS
  return actions.find((name) => candidates.some((candidate) => candidate === name.toLowerCase()))
}

function elementRefOf(action: { target?: string | ComputerTarget; elementId?: string }): string | undefined {
  if (typeof action.target === "object" && action.target.kind === "element") return action.target.elementId
  if (typeof action.elementId === "string" && action.elementId.length > 0) return action.elementId
  return undefined
}

function targetReferenceOf(action: { target?: string | ComputerTarget }): ElementReference | undefined {
  if (typeof action.target === "object" && action.target.kind === "element") return action.target.reference
  return undefined
}

// Generation-scoped refs: when the caller binds its target to the observation
// it saw (reference.observationId/generation), acting against any other
// observation must refuse as target_stale instead of silently rebinding to
// whatever now shares the same ref string.
function bindingMismatch(
  action: { target?: string | ComputerTarget },
  snapshot: CuaSnapshot,
): { observationId?: string; generation?: number } | undefined {
  const reference = targetReferenceOf(action)
  if (reference === undefined) return undefined
  if (reference.observationId !== undefined || reference.generation !== undefined) {
    const binding = {
      ...(reference.observationId === undefined ? {} : { observationId: reference.observationId }),
      ...(reference.generation === undefined ? {} : { generation: reference.generation }),
    }
    if (!bindingMatches(snapshot, binding)) return binding
  }
  return undefined
}

function staleBinding(
  ref: string,
  expected: { observationId?: string; generation?: number },
  actual: CuaSnapshot,
): ActionResult {
  const message = staleBindingMessage(ref, expected, actual)
  return {
    success: false,
    status: "rejected",
    message,
    error: { code: "target_stale", message, retryable: true },
  }
}

function pointOf(target: string | ComputerTarget | undefined): Point | undefined {
  if (target === undefined || typeof target === "string" || target.kind !== "point") return undefined
  return { x: target.x, y: target.y }
}

function x11WindowIdOf(elementId: string): string | undefined {
  if (!elementId.startsWith("x11:")) return undefined
  const id = elementId.slice("x11:".length)
  return /^0x[0-9a-f]+$/i.test(id) ? id : undefined
}

function buttonNumber(button: "left" | "right" | "middle" | undefined): number {
  if (button === "middle") return 2
  if (button === "right") return 3
  return 1
}

function durationOf(action: { metadata?: Metadata }, fallback: number): number {
  const value = action.metadata?.durationMs
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : fallback
}

function splitKeys(keys: string): string[] {
  return keys
    .split("+")
    .map((key) => key.trim())
    .filter((key) => key.length > 0)
}

function jsonText(value: JsonValue): string {
  if (typeof value === "string") return value
  return JSON.stringify(value) ?? ""
}

function hashText(text: string): string {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

function parseWaitCondition(condition: string, timeoutMs: number | undefined): CuaWaitCondition {
  const timeout = timeoutMs === undefined ? {} : { timeoutMs }
  const separator = condition.indexOf(":")
  if (separator < 0) return { ...timeout, text: condition }
  const prefix = condition.slice(0, separator).trim().toLowerCase()
  const value = condition.slice(separator + 1).trim()
  if (prefix === "ref") return { ...timeout, ref: value }
  if (prefix === "name") return { ...timeout, name: value }
  if (prefix === "role") return { ...timeout, role: value }
  if (prefix === "state") return { ...timeout, state: value }
  if (prefix === "window") return { ...timeout, windowTitle: value }
  if (prefix === "text") return { ...timeout, text: value }
  return { ...timeout, text: condition }
}
