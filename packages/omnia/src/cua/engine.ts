import { createDarwinBackend } from "./backends/darwin"
import { createLinuxBackend } from "./backends/linux"
import { createWindowsBackend } from "./backends/windows"
import { DEFAULT_SNAPSHOT_MAX_ELEMENTS, snapshotForOptions, snapshotOptionsSupersetOf } from "./backends/snapshot-limit"
import type {
  CuaAction,
  CuaActionResult,
  CuaBackend,
  CuaCapabilities,
  CuaElement,
  CuaFindQuery,
  CuaPlatform,
  CuaSnapshot,
  CuaSnapshotOptions,
  CuaStateDelta,
  CuaWaitCondition,
  CuaWaitResult,
} from "./types"

export const DEFAULT_SNAPSHOT_TTL_MS = 350

export function createBackend(platform: CuaPlatform): CuaBackend {
  if (platform === "darwin") return createDarwinBackend()
  if (platform === "win32") return createWindowsBackend()
  return createLinuxBackend()
}

export interface CuaEngineOptions {
  readonly backend?: CuaBackend
  readonly platform?: CuaPlatform
  readonly cacheTtlMs?: number
  readonly now?: () => number
}

export class CuaEngine {
  readonly platform: CuaPlatform
  readonly backendName: string
  private readonly backend: CuaBackend
  private readonly cacheTtlMs: number
  private readonly now: () => number
  private generation = 0
  private latest: CuaSnapshot | undefined
  private latestOptions: CuaSnapshotOptions = {}
  private snapshotPending: { options: CuaSnapshotOptions; promise: Promise<CuaSnapshot> } | undefined
  private actionQueue: Promise<unknown> = Promise.resolve()
  private cache:
    | {
        readonly snapshot: CuaSnapshot
        readonly at: number
        readonly options: CuaSnapshotOptions
      }
    | undefined

  constructor(options: CuaEngineOptions = {}) {
    this.backend = options.backend ?? createBackend(options.platform ?? processPlatform())
    this.platform = this.backend.platform
    this.backendName = this.backend.name
    this.now = options.now ?? Date.now
    this.cacheTtlMs = options.cacheTtlMs ?? backendFreshness(this.backend) ?? DEFAULT_SNAPSHOT_TTL_MS
  }

  available(): Promise<boolean> {
    return this.backend.available()
  }

  capabilities(): Promise<CuaCapabilities> {
    return this.backend.capabilities()
  }

  latestSnapshot(): CuaSnapshot | undefined {
    return this.latest
  }

  async snapshot(options: CuaSnapshotOptions = {}): Promise<CuaSnapshot> {
    const cached = this.reuse(options)
    if (cached !== undefined) return cached
    return this.capture(options)
  }

  // Reads are never queued behind actions. A read whose options are covered by
  // an in-flight walk shares that walk instead of racing a duplicate; a read
  // that needs broader options starts its own walk. The tradeoff: a read that
  // lands mid-action can observe a transient state, so verification never uses
  // a concurrent read as evidence and always captures its own post-action read
  // inside the serialized action path.
  private capture(options: CuaSnapshotOptions): Promise<CuaSnapshot> {
    const pending = this.snapshotPending
    if (pending !== undefined && snapshotOptionsSupersetOf(pending.options, options, this.defaultMaxElements())) {
      return pending.promise.then((shared) => {
        const covered = snapshotForOptions(shared, pending.options, options, this.defaultMaxElements())
        return covered ?? this.startCapture(options)
      })
    }
    return this.startCapture(options)
  }

  private startCapture(options: CuaSnapshotOptions): Promise<CuaSnapshot> {
    const promise = this.backend.snapshot(options).then((fresh) => this.acceptSnapshot(fresh, options))
    const entry = { options, promise }
    this.snapshotPending = entry
    const settle = () => {
      if (this.snapshotPending === entry) this.snapshotPending = undefined
    }
    promise.then(settle, settle)
    return promise
  }

  private acceptSnapshot(fresh: CuaSnapshot, options: CuaSnapshotOptions): CuaSnapshot {
    const generation = Math.max(this.generation + 1, fresh.generation)
    this.generation = generation
    const snapshot = fresh.generation === generation ? fresh : { ...fresh, generation }
    this.latest = snapshot
    this.latestOptions = { ...options }
    this.cache = { snapshot, at: this.now(), options: { ...options } }
    return snapshot
  }

  private defaultMaxElements(): number {
    return this.backend.defaultMaxElements ?? DEFAULT_SNAPSHOT_MAX_ELEMENTS
  }

  invalidate(): void {
    this.cache = undefined
  }

  async refresh(options: CuaSnapshotOptions = {}): Promise<CuaSnapshot> {
    this.invalidate()
    return this.snapshot(options)
  }

  async resolveRef(ref: string): Promise<CuaElement | undefined> {
    const snapshot = await this.snapshot()
    return elementByRef(snapshot, ref)
  }

  // Callers that need to search beyond the default observe budget (find must
  // not miss matches the budget truncated) pass snapshot options here; they
  // share the snapshot cache with an explicit snapshot(options) call.
  async find(query: CuaFindQuery, options: CuaSnapshotOptions = {}): Promise<CuaElement[]> {
    const snapshot = await this.snapshot(options)
    return this.backend.find(query, snapshot)
  }

  async execute(action: CuaAction): Promise<CuaActionResult> {
    // Actions run one at a time: interleaved before/after snapshots would
    // misattribute another action's changes to this one.
    const run = this.actionQueue.then(() => this.executeAction(action))
    this.actionQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async executeAction(action: CuaAction): Promise<CuaActionResult> {
    const captureId = captureIdOf(action)
    // A valid capture id must not be invalidated by a verification refresh;
    // reuse the exact snapshot the capture refers to as the before-state.
    const captureSnapshot = captureId !== undefined && captureId === this.latest?.id ? this.latest : undefined
    if (captureId !== undefined && captureSnapshot === undefined) {
      return refusal(
        action,
        "capture_stale",
        `The capture ${captureId} is not the latest snapshot; re-observe before acting.`,
        this.generation,
        false,
      )
    }

    let beforeError: string | undefined
    let afterError: string | undefined
    // The last snapshot is the delta baseline even past its TTL: actions are
    // serialized, so it is the state the previous action left behind. Only
    // this action's own post-action read counts as verification evidence.
    const before =
      captureSnapshot ??
      this.cache?.snapshot ??
      (await this.snapshot().catch((error: unknown) => {
        beforeError = error instanceof Error ? error.message : "snapshot failed"
        return undefined
      }))
    const beforeOptions = this.cache?.options ?? this.latestOptions
    const outcome = await this.backend
      .execute(action, before)
      .catch((error: unknown) => failed(action, error, this.generation))
    // The pre-action cache must not serve any later read: the action replaced
    // the state it held.
    this.invalidate()
    const observed = await this.resolveAfter(action, before, outcome).catch((error: unknown) => {
      afterError = error instanceof Error ? error.message : "snapshot failed"
      return undefined
    })
    const after = observed?.snapshot
    // Compare like budgets and scopes: a broad before-state is re-capped to the
    // default after-state before the delta, otherwise budget-only drops would
    // read as real state changes and verify an action that did nothing.
    const verifyBefore =
      before === undefined || after === undefined
        ? before
        : (snapshotForOptions(before, beforeOptions, {}, this.defaultMaxElements()) ?? before)
    const aligned =
      before !== undefined &&
      after !== undefined &&
      (verifyBefore !== before || snapshotOptionsSupersetOf({}, beforeOptions, this.defaultMaxElements()))
    const deltaOnly = after === undefined && observed?.delta !== undefined && before !== undefined
    const stateDelta =
      after !== undefined
        ? computeStateDelta(verifyBefore, after)
        : (observed?.delta ?? computeStateDelta(before, after))
    const focusedMoved =
      aligned && before !== undefined && after !== undefined && before.focusedRef !== after.focusedRef
    // FAIL-CLOSED: without an aligned before/after pair, only refs present in
    // both snapshots count as change evidence; added/removed refs may be scope
    // artifacts. A backend delta must prove a newer generation.
    const observedChange =
      after !== undefined
        ? aligned
          ? hasDelta(stateDelta) || focusedMoved
          : (stateDelta.changedRefs?.length ?? 0) > 0
        : deltaOnly && hasDelta(stateDelta)
    const verified = outcome.ok && verdict(action, outcome, verifyBefore, after, stateDelta, observedChange)
    const warnings = [...(outcome.warnings ?? [])]
    if (outcome.ok && !verified) warnings.push(verificationWarning(action))
    if (beforeError !== undefined) warnings.push(`The pre-action snapshot failed: ${beforeError}`)
    if (afterError !== undefined) warnings.push(`The verification snapshot failed: ${afterError}`)
    return {
      ...outcome,
      verified,
      generation: after?.generation ?? this.generation,
      stateDelta,
      ...(warnings.length === 0 ? {} : { warnings }),
    }
  }

  private async resolveAfter(
    action: CuaAction,
    before: CuaSnapshot | undefined,
    outcome: CuaActionResult,
  ): Promise<{ snapshot?: CuaSnapshot; delta?: CuaStateDelta }> {
    const observation = outcome.observation
    if (observation !== undefined && isFreshObservation(before, observation, this.latest)) {
      return { snapshot: this.acceptSnapshot(observation, {}) }
    }
    if (outcome.delta !== undefined && before !== undefined && outcome.generation > before.generation) {
      return { delta: outcome.delta }
    }
    const refreshed = await this.refreshAffected(action, before)
    if (refreshed !== undefined) return { snapshot: this.acceptSnapshot(refreshed, {}) }
    return { snapshot: await this.startCapture({}) }
  }

  private async refreshAffected(action: CuaAction, before: CuaSnapshot | undefined): Promise<CuaSnapshot | undefined> {
    if (before === undefined) return undefined
    const scope = affectedScope(action, before)
    if (scope.windowRef !== undefined && this.backend.refreshWindow !== undefined) {
      return this.backend.refreshWindow(scope.windowRef).catch(() => undefined)
    }
    if (scope.app !== undefined && this.backend.refreshApplication !== undefined) {
      return this.backend.refreshApplication(scope.app).catch(() => undefined)
    }
    return undefined
  }

  async waitFor(condition: CuaWaitCondition): Promise<CuaWaitResult> {
    const result = await this.backend.waitFor(condition)
    this.invalidate()
    return result
  }

  async dispose(): Promise<void> {
    this.cache = undefined
    this.latest = undefined
    this.latestOptions = {}
    await this.backend.dispose()
  }

  // A cached walk is reused while it is within its freshness window, known to
  // the current generation, and its options are a superset of the request.
  // The produced snapshot is re-capped to the request, so a full walk serves a
  // capped observe without reporting truncated: false for the capped view.
  private reuse(options: CuaSnapshotOptions): CuaSnapshot | undefined {
    const cached = this.cache
    if (cached === undefined) return undefined
    if (cached.snapshot.generation !== this.generation) return undefined
    if (this.now() - cached.at >= this.cacheTtlMs) return undefined
    return snapshotForOptions(cached.snapshot, cached.options, options, this.defaultMaxElements())
  }
}

export function elementByRef(snapshot: CuaSnapshot | undefined, ref: string): CuaElement | undefined {
  return (snapshot?.elements ?? []).find((element) => element.ref === ref)
}

export function computeStateDelta(before: CuaSnapshot | undefined, after: CuaSnapshot | undefined): CuaStateDelta {
  const beforeByRef = new Map((before?.elements ?? []).map((element) => [element.ref, element]))
  const afterByRef = new Map((after?.elements ?? []).map((element) => [element.ref, element]))
  const addedRefs = [...afterByRef.keys()].filter((ref) => !beforeByRef.has(ref))
  const removedRefs = [...beforeByRef.keys()].filter((ref) => !afterByRef.has(ref))
  const changedRefs = [...afterByRef.entries()].flatMap(([ref, element]) => {
    const prior = beforeByRef.get(ref)
    return prior !== undefined && elementSignature(prior) !== elementSignature(element) ? [ref] : []
  })
  return {
    ...(after?.focusedRef === undefined ? {} : { focusedRef: after.focusedRef }),
    ...(addedRefs.length === 0 ? {} : { addedRefs }),
    ...(removedRefs.length === 0 ? {} : { removedRefs }),
    ...(changedRefs.length === 0 ? {} : { changedRefs }),
  }
}

function processPlatform(): CuaPlatform {
  if (process.platform === "darwin") return "darwin"
  if (process.platform === "win32") return "win32"
  return "linux"
}

function backendFreshness(backend: CuaBackend): number | undefined {
  if (!("freshnessMs" in backend)) return undefined
  const value: unknown = backend.freshnessMs
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function captureIdOf(action: CuaAction): string | undefined {
  if (action.type === "click" || action.type === "drag") return action.captureId
  return undefined
}

// A driver-provided observation is evidence only when it is a distinct read at
// a strictly newer generation than the pre-action snapshot. A backend that
// echoes the state it was handed — under a new id but the same generation —
// proves nothing, so "newer" means strictly greater.
function isFreshObservation(
  before: CuaSnapshot | undefined,
  observation: CuaSnapshot,
  latest: CuaSnapshot | undefined,
): boolean {
  if (observation.id === latest?.id) return false
  if (before === undefined) return true
  return observation.id !== before.id && observation.generation > before.generation
}

function actionRef(action: CuaAction): string | undefined {
  return "ref" in action && typeof action.ref === "string" ? action.ref : undefined
}

// The window/app an action can be expected to change: its target element's
// window, the target window itself, or the focused window for global input.
function affectedScope(action: CuaAction, before: CuaSnapshot): { windowRef?: string; app?: string } {
  const ref = actionRef(action)
  if (ref !== undefined) {
    const element = elementByRef(before, ref)
    const window = before.windows.find((candidate) => candidate.ref === ref)
    const windowRef = element?.windowRef ?? window?.ref
    const app = element?.application ?? window?.app
    return {
      ...(windowRef === undefined ? {} : { windowRef }),
      ...(app === undefined ? {} : { app }),
    }
  }
  const focusedElement = before.focusedRef === undefined ? undefined : elementByRef(before, before.focusedRef)
  const windowRef = focusedElement?.windowRef ?? before.windows.find((candidate) => candidate.focused)?.ref
  if (windowRef === undefined) return {}
  const window = before.windows.find((candidate) => candidate.ref === windowRef)
  return { windowRef, ...(window?.app === undefined ? {} : { app: window.app }) }
}

function elementSignature(element: CuaElement): string {
  return JSON.stringify([
    element.role,
    element.name,
    element.text,
    element.value,
    element.enabled,
    element.focused,
    element.editable,
    element.states,
    element.actions,
  ])
}

function hasDelta(delta: CuaStateDelta): boolean {
  return (
    (delta.addedRefs?.length ?? 0) > 0 || (delta.removedRefs?.length ?? 0) > 0 || (delta.changedRefs?.length ?? 0) > 0
  )
}

function verdict(
  action: CuaAction,
  outcome: CuaActionResult,
  before: CuaSnapshot | undefined,
  after: CuaSnapshot | undefined,
  stateDelta: CuaStateDelta,
  observedChange: boolean,
): boolean {
  if (!outcome.ok) return false
  switch (action.type) {
    case "focus":
      // FAIL-CLOSED: focus verifies only from an independent after-snapshot
      // that names the ref. A backend-supplied delta naming the ref as the new
      // focus is the backend describing its own action, not a read of the
      // desktop, so it never substitutes for the missing snapshot.
      return isFocused(after, action.ref)
    case "set_value":
      return valueMatches(elementByRef(after, action.ref), action.value)
    case "window":
      return windowVerified(action.action, action.ref, before, after)
    case "invoke":
    case "select":
    case "expand":
    case "collapse":
    case "increment":
    case "decrement":
    case "show_menu":
    case "scroll_into_view":
    case "dismiss":
      // Dismiss is only verified when the transient surface actually left the
      // tree: a pressed Escape with no observable change is honest success but
      // cannot be called verified.
      return observedChange
    case "click":
    case "drag":
      // Pointer input is only verified on positive evidence: an observable
      // state change or a focus move. Delivery alone (pointer/keyboard) proves
      // the input was sent, not that it landed, so it must never verify.
      return observedChange
    case "type":
      // FAIL-CLOSED: with a target ref the only acceptable evidence is that
      // ref's own value read back from an independent after-snapshot. A
      // backend delta (or any other element's change) that merely names the
      // ref proves nothing about which text landed in it.
      if (action.ref !== undefined) return valueMatches(elementByRef(after, action.ref), action.text)
      return observedChange
    default:
      // FAIL-CLOSED: never trust a backend's self-reported verified flag
      // without an independent readback. Unlisted actions verify only on
      // observable evidence.
      return observedChange
  }
}

function isFocused(snapshot: CuaSnapshot | undefined, ref: string): boolean {
  if (snapshot?.focusedRef === ref) return true
  return (snapshot?.elements ?? []).some((element) => element.ref === ref && element.focused)
}

function valueMatches(element: CuaElement | undefined, value: string): boolean {
  if (element === undefined) return false
  if (element.value !== undefined && element.value === value) return true
  return element.text !== undefined && element.text === value
}

function windowVerified(
  action: "focus" | "minimize" | "restore" | "close" | "maximize" | "unmaximize" | "tile" | "move",
  ref: string,
  before: CuaSnapshot | undefined,
  after: CuaSnapshot | undefined,
): boolean {
  const prior = (before?.windows ?? []).find((window) => window.ref === ref)
  const current = (after?.windows ?? []).find((window) => window.ref === ref)
  // FAIL-CLOSED: a missing after-snapshot is not evidence of disappearance.
  // Close verifies only when the before-state knew the window and a real
  // after-snapshot no longer contains it.
  if (action === "close") {
    if (after === undefined || prior === undefined) return false
    return current === undefined
  }
  if (action === "focus") return current !== undefined && current.focused
  // Minimize must be proven by the platform's minimized state. A window that
  // merely lost focus, or vanished entirely (which could be a close), is not
  // evidence that the minimize landed.
  if (action === "minimize") return current !== undefined && current.minimized === true
  if (action === "restore") {
    if (current === undefined || current.minimized === true) return false
    return current.focused || prior?.focused !== true
  }
  if (action === "tile" || action === "move" || action === "maximize" || action === "unmaximize") {
    // Geometry changes can only be verified from real bounds on both sides; a
    // missing bounds snapshot must not pass as verified.
    if (current === undefined || prior === undefined) return false
    const priorBounds = prior.bounds
    const currentBounds = current.bounds
    if (priorBounds === undefined || currentBounds === undefined) return false
    return (
      priorBounds.x !== currentBounds.x ||
      priorBounds.y !== currentBounds.y ||
      priorBounds.width !== currentBounds.width ||
      priorBounds.height !== currentBounds.height
    )
  }
  return false
}

function refusal(
  action: CuaAction,
  code: string,
  message: string,
  generation: number,
  retryable = true,
): CuaActionResult {
  return {
    ok: false,
    action,
    verified: false,
    message,
    delivery: "refused",
    generation,
    error: { code, message, retryable },
  }
}

function failed(action: CuaAction, error: unknown, generation: number): CuaActionResult {
  const message = error instanceof Error ? error.message : "The action failed."
  return {
    ok: false,
    action,
    verified: false,
    message,
    delivery: "refused",
    generation,
    error: { code: "action_failed", message, retryable: true },
  }
}

function verificationWarning(action: CuaAction): string {
  return `The ${action.type} action completed, but the follow-up snapshot did not confirm the change.`
}
