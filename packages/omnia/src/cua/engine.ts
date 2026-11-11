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
  CuaRefBinding,
  CuaSnapshot,
  CuaSnapshotOptions,
  CuaStateDelta,
  CuaWaitCondition,
  CuaWaitResult,
  CuaWindow,
} from "./types"
import { StaleRefError } from "./types"

export const DEFAULT_SNAPSHOT_TTL_MS = 350

// Refs are generation-scoped and the engine is the ref authority: it mints
// `${base}${REF_SCOPE_SEPARATOR}${generation}` for every element and window it
// accepts, so a ref string is only meaningful inside the observation that
// minted it. Backend refs are content-addressed strings whose occurrence index
// is authoritative, so a shifted index yields a different base ref — and
// therefore a refusal — instead of a silent bind to a different widget.
const REF_SCOPE_SEPARATOR = "@g"
// How many observations stay addressable by id. Old observations are evicted
// first; the current one is never evicted, because that is the one a caller is
// most likely to be holding.
const OBSERVATION_HISTORY = 32

export function scopedRef(ref: string, generation: number): string {
  return `${ref}${REF_SCOPE_SEPARATOR}${generation}`
}

// The generation-independent identity of a scoped ref: the string the backend
// minted it from. Two observations of an unchanged desktop describe the same
// element with the same identity and different scoped refs.
export function refIdentity(ref: string): string {
  const separator = ref.lastIndexOf(REF_SCOPE_SEPARATOR)
  if (separator < 0) return ref
  return /^\d+$/.test(ref.slice(separator + REF_SCOPE_SEPARATOR.length)) ? ref.slice(0, separator) : ref
}

export function windowAsElement(window: CuaWindow): CuaElement {
  return {
    ref: window.ref,
    backendRef: window.backendRef,
    role: "window",
    name: window.title,
    enabled: true,
    focused: window.focused,
    editable: false,
    actions: [],
    states: window.focused ? ["focused"] : [],
    generation: window.generation,
    application: window.app,
    ...(window.bounds === undefined ? {} : { bounds: window.bounds }),
  }
}

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
  private disposed = false
  private captureEpoch = 0
  private generation = 0
  private latest: CuaSnapshot | undefined
  private latestOptions: CuaSnapshotOptions = {}
  private snapshotPending: { epoch: number; options: CuaSnapshotOptions; promise: Promise<CuaSnapshot> } | undefined
  private actionQueue: Promise<unknown> = Promise.resolve()
  // Observations stay addressable by id so a ref paired with an observation can
  // be resolved against exactly that observation.
  private observations = new Map<string, CuaSnapshot>()
  private mintedObservations = 0
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
    if (this.disposed) return Promise.resolve(false)
    return this.backend.available()
  }

  capabilities(): Promise<CuaCapabilities> {
    this.assertActive()
    return this.backend.capabilities()
  }

  latestSnapshot(): CuaSnapshot | undefined {
    return this.latest
  }

  async snapshot(options: CuaSnapshotOptions = {}): Promise<CuaSnapshot> {
    this.assertActive()
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
    if (pending !== undefined && pending.epoch === this.captureEpoch && snapshotOptionsSupersetOf(pending.options, options, this.defaultMaxElements())) {
      return pending.promise.then((shared) => {
        const covered = snapshotForOptions(shared, pending.options, options, this.defaultMaxElements())
        return covered ?? this.startCapture(options)
      })
    }
    return this.startCapture(options)
  }

  private startCapture(options: CuaSnapshotOptions): Promise<CuaSnapshot> {
    this.assertActive()
    const epoch = this.captureEpoch
    const promise = this.backend.snapshot(options).then((fresh) => {
      this.assertActive()
      // A pre-action capture must never refill the post-action cache.
      return epoch === this.captureEpoch ? this.acceptSnapshot(fresh, options) : this.snapshot(options)
    })
    const entry = { epoch, options, promise }
    this.snapshotPending = entry
    const settle = () => {
      if (this.snapshotPending === entry) this.snapshotPending = undefined
    }
    promise.then(settle, settle)
    return promise
  }

  private acceptSnapshot(fresh: CuaSnapshot, options: CuaSnapshotOptions): CuaSnapshot {
    this.assertActive()
    // Every capture is a new observation, even when the desktop did not change:
    // a generation tied to desktop state would let a ref from the previous
    // observation still look current, and two observations must never be
    // distinguishable only by refs.
    const generation = Math.max(this.generation + 1, fresh.generation)
    this.generation = generation
    const snapshot = scopeSnapshot(fresh, generation, this.observationIdFor(fresh.id, generation))
    this.latest = snapshot
    this.latestOptions = { ...options }
    this.cache = { snapshot, at: this.now(), options: { ...options } }
    this.remember(snapshot)
    return snapshot
  }

  // Observation ids identify an observation, not a walk. A backend that reuses
  // an id for a second capture would let refs minted under the first bind to
  // the second, so a repeated id gets a fresh one.
  private observationIdFor(id: string, generation: number): string {
    if (id.length > 0 && !this.observations.has(id)) return id
    this.mintedObservations += 1
    return `cua-obs-${generation}-${this.mintedObservations}`
  }

  private remember(snapshot: CuaSnapshot): void {
    this.observations.set(snapshot.id, snapshot)
    while (this.observations.size > OBSERVATION_HISTORY) {
      const oldest = this.observations.keys().next()
      if (oldest.done || oldest.value === this.latest?.id) break
      this.observations.delete(oldest.value)
    }
  }

  private defaultMaxElements(): number {
    return this.backend.defaultMaxElements ?? DEFAULT_SNAPSHOT_MAX_ELEMENTS
  }

  invalidate(): void {
    this.captureEpoch += 1
    this.cache = undefined
  }

  async refresh(options: CuaSnapshotOptions = {}): Promise<CuaSnapshot> {
    this.invalidate()
    return this.snapshot(options)
  }

  // Resolve a ref against the observation it belongs to. A ref is returned only
  // when that observation contains it; an unknown observation, or a ref that
  // observation does not contain, throws StaleRefError naming both ids. The
  // engine never falls back to a newer observation whose element happens to
  // share the ref string, because a shifted occurrence index can put a
  // different widget at the same string.
  resolveRef(observationId: string, ref: string): CuaElement {
    const observation = this.observations.get(observationId)
    if (observation === undefined) {
      throw new StaleRefError({ observationId, ref, reason: "unknown_observation" })
    }
    const element = elementByRef(observation, ref) ?? windowElementByRef(observation, ref)
    if (element === undefined) {
      throw new StaleRefError({
        observationId,
        generation: observation.generation,
        ref,
        reason: "absent_ref",
      })
    }
    return element
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
    this.assertActive()
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
    const generationMismatch = this.refuseGenerationMismatch(action, before)
    if (generationMismatch !== undefined) return generationMismatch
    this.assertActive()
    const outcome = await this.backend
      .execute(action, before)
      .catch((error: unknown) => failed(action, error, this.generation))
    this.assertActive()
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
    // Refs are generation-scoped, so a moved focus is a change of identity: the
    // same focused node re-scoped to a later generation is not a move, and
    // counting one would verify an action that changed nothing.
    const focusedMoved =
      aligned &&
      before !== undefined &&
      after !== undefined &&
      refIdentity(before.focusedRef ?? "") !== refIdentity(after.focusedRef ?? "")
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

  // No action is answered against a generation its target did not come from.
  // An action that names an observation or a generation must match the
  // observation this action runs against; otherwise the caller is holding a ref
  // the desktop has since replaced and has to re-observe. Actions without a
  // binding still depend on their ref being present in that observation, which
  // the backend enforces.
  private refuseGenerationMismatch(action: CuaAction, before: CuaSnapshot | undefined): CuaActionResult | undefined {
    const current = before ?? this.latest
    if (current === undefined) return undefined
    const binding = actionBinding(action)
    if (binding === undefined || bindingMatches(current, binding)) return undefined
    const message = staleBindingMessage(actionRef(action) ?? `${action.type} action`, binding, current)
    return refusal(action, "stale_ref", message, current.generation)
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
      // The backend re-walks its own tree, so it addresses the window by the
      // identity the engine scoped away.
      return this.backend.refreshWindow(refIdentity(scope.windowRef)).catch(() => undefined)
    }
    if (scope.app !== undefined && this.backend.refreshApplication !== undefined) {
      return this.backend.refreshApplication(scope.app).catch(() => undefined)
    }
    return undefined
  }

  async waitFor(condition: CuaWaitCondition): Promise<CuaWaitResult> {
    this.assertActive()
    // The backend matches a wait ref against its own walk, which carries the
    // unscoped backend refs, so the scope is dropped and only the identity is
    // forwarded.
    const forwarded =
      condition.ref === undefined ? condition : { ...condition, ref: refIdentity(condition.ref) }
    const result = await this.backend.waitFor(forwarded)
    this.assertActive()
    this.invalidate()
    return result
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("The computer control engine was disposed.")
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.snapshotPending = undefined
    this.cache = undefined
    this.latest = undefined
    this.latestOptions = {}
    this.observations.clear()
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

export function windowElementByRef(snapshot: CuaSnapshot | undefined, ref: string): CuaElement | undefined {
  const window = (snapshot?.windows ?? []).find((candidate) => candidate.ref === ref)
  return window === undefined ? undefined : windowAsElement(window)
}

// Readbacks compare two observations of one action, so they match on the ref's
// identity rather than its scoped string: the after-observation necessarily
// minted new refs for the same elements.
export function elementByIdentity(snapshot: CuaSnapshot | undefined, ref: string): CuaElement | undefined {
  const identity = refIdentity(ref)
  return (snapshot?.elements ?? []).find((element) => refIdentity(element.ref) === identity)
}

export function windowByIdentity(snapshot: CuaSnapshot | undefined, ref: string): CuaWindow | undefined {
  const identity = refIdentity(ref)
  return (snapshot?.windows ?? []).find((candidate) => refIdentity(candidate.ref) === identity)
}

export function computeStateDelta(before: CuaSnapshot | undefined, after: CuaSnapshot | undefined): CuaStateDelta {
  // Refs are scoped to their observation, so the delta is keyed by identity and
  // each side reports the ref it minted: a removed ref is one the
  // before-observation owned, an added or changed ref is one the
  // after-observation owns.
  const prior = new Map((before?.elements ?? []).map((element) => [refIdentity(element.ref), element]))
  const current = new Map((after?.elements ?? []).map((element) => [refIdentity(element.ref), element]))
  const addedRefs = [...current.entries()].flatMap(([identity, element]) => (prior.has(identity) ? [] : [element.ref]))
  const removedRefs = [...prior.entries()].flatMap(([identity, element]) => (current.has(identity) ? [] : [element.ref]))
  const changedRefs = [...current.values()].flatMap((element) => {
    const beforeElement = prior.get(refIdentity(element.ref))
    return beforeElement !== undefined && elementSignature(beforeElement) !== elementSignature(element)
      ? [element.ref]
      : []
  })
  return {
    ...(after?.focusedRef === undefined ? {} : { focusedRef: after.focusedRef }),
    ...(addedRefs.length === 0 ? {} : { addedRefs }),
    ...(removedRefs.length === 0 ? {} : { removedRefs }),
    ...(changedRefs.length === 0 ? {} : { changedRefs }),
  }
}

// The observation/generation pair an action declares. The driver forwards it
// on every action it bridges to a remote computer, pointer clicks included,
// and the union does not expose it on the targetless variants (key, dismiss),
// which still have to honour a pair they carry.
function actionBinding(action: CuaAction): { observationId?: string; generation?: number } | undefined {
  const scope: { readonly type: string } & CuaRefBinding = action
  if (scope.observationId === undefined && scope.generation === undefined) return undefined
  return {
    ...(scope.observationId === undefined ? {} : { observationId: scope.observationId }),
    ...(scope.generation === undefined ? {} : { generation: scope.generation }),
  }
}

export function bindingMatches(
  snapshot: CuaSnapshot,
  binding: { observationId?: string; generation?: number },
): boolean {
  if (binding.observationId !== undefined && binding.observationId !== snapshot.id) return false
  if (binding.generation !== undefined && binding.generation !== snapshot.generation) return false
  return true
}

export function staleBindingMessage(
  ref: string,
  binding: { observationId?: string; generation?: number },
  current: CuaSnapshot,
): string {
  const from =
    binding.observationId === undefined
      ? `generation ${binding.generation}`
      : binding.generation === undefined
        ? `observation ${binding.observationId}`
        : `observation ${binding.observationId} (generation ${binding.generation})`
  return `Target ${ref} is from ${from}, not the current ${current.id} (generation ${current.generation}); re-observe before acting.`
}

function scopeSnapshot(fresh: CuaSnapshot, generation: number, observationId: string): CuaSnapshot {
  // Every record carries the observation's generation, not the backend's: the
  // scoped ref, the reference pair an agent is handed, and the generation it is
  // paired with must all name the same observation.
  const windows = fresh.windows.map((window) => ({
    ...window,
    ref: scopedRef(window.ref, generation),
    generation,
  }))
  const elements = fresh.elements.map((element) => ({
    ...element,
    ref: scopedRef(element.ref, generation),
    generation,
    ...(element.windowRef === undefined ? {} : { windowRef: scopedRef(element.windowRef, generation) }),
    ...(element.parentRef === undefined ? {} : { parentRef: scopedRef(element.parentRef, generation) }),
  }))
  return {
    ...fresh,
    id: observationId,
    generation,
    windows,
    elements,
    ...(fresh.focusedRef === undefined ? {} : { focusedRef: scopedRef(fresh.focusedRef, generation) }),
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
// Refs are matched on identity so a caller's ref still resolves against the
// observation the action runs against.
function affectedScope(action: CuaAction, before: CuaSnapshot): { windowRef?: string; app?: string } {
  const ref = actionRef(action)
  if (ref !== undefined) {
    const element = elementByIdentity(before, ref)
    const window = windowByIdentity(before, ref)
    const windowRef = element?.windowRef ?? window?.ref
    const app = element?.application ?? window?.app
    return {
      ...(windowRef === undefined ? {} : { windowRef }),
      ...(app === undefined ? {} : { app }),
    }
  }
  const focusedElement = before.focusedRef === undefined ? undefined : elementByIdentity(before, before.focusedRef)
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
      return valueMatches(elementByIdentity(after, action.ref), action.value)
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
      if (action.ref !== undefined) return valueMatches(elementByIdentity(after, action.ref), action.text)
      return observedChange
    default:
      // FAIL-CLOSED: never trust a backend's self-reported verified flag
      // without an independent readback. Unlisted actions verify only on
      // observable evidence.
      return observedChange
  }
}

function isFocused(snapshot: CuaSnapshot | undefined, ref: string): boolean {
  if (snapshot?.focusedRef !== undefined && refIdentity(snapshot.focusedRef) === refIdentity(ref)) return true
  return elementByIdentity(snapshot, ref)?.focused === true
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
  // Both sides are matched by identity: the after-observation necessarily
  // minted new scoped refs for the same windows.
  const prior = windowByIdentity(before, ref)
  const current = windowByIdentity(after, ref)
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
