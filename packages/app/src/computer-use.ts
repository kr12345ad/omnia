export type ComputerUseModelState =
  | "NOT_INSTALLED"
  | "DOWNLOADING"
  | "INSTALLED"
  | "STARTING"
  | "READY"
  | "LOADING"
  | "UNLOADING"
  | "FAILED"
  | "DISABLED"

export interface ComputerUseModel {
  id: string
  displayName: string
  provider: string
  description?: string
  quantization?: string
  modelSizeBytes?: number
  recommended?: boolean
  enabled: boolean
}

export interface ComputerUseModelStatus {
  model: ComputerUseModel
  state: ComputerUseModelState
  installed: boolean
  loaded: boolean
  progress?: number
  bytesOnDisk?: number
  runtimeBackend?: string
  reason?: string
}

export interface ComputerUseStatus {
  mode: string
  installedModels: number
  localRuntime: {
    available: boolean
    command?: string
    backend?: string
    reason?: string
  }
}

export interface ComputerUseSettings {
  allowDownloads: boolean
  mode: string
  allowRemoteScreen?: boolean
}

export interface ComputerUseRuntimeStatus {
  runtime: {
    id: string
    variant: "cpu" | "cuda" | "rocm" | "vulkan" | "metal"
    displayName: string
    description?: string
    backend: string
  }
  state: ComputerUseModelState
  installed: boolean
  bundled: boolean
  progress?: number
  bytes?: number
  bytesOnDisk?: number
  reason?: string
}

export interface ComputerUseCalibrationProfile {
  screen: { width: number; height: number }
  scaleX: number
  scaleY: number
  offsetX: number
  offsetY: number
  samples: number
  measuredAt: number
}

export interface ComputerUseCalibrationPoint {
  id: string
  x: number
  y: number
}

export interface ComputerUseCalibrationMeasurement {
  pointId: string
  x: number
  y: number
  observedX?: number
  observedY?: number
  deltaX?: number
  deltaY?: number
  error?: string
}

export interface ComputerUseCalibrationStatus {
  profile?: ComputerUseCalibrationProfile
  screen?: { width: number; height: number }
  stale: boolean
  calibrated: boolean
}

// Computer-use approvals
//
// The permission dock is the only place a human can see what a computer-use
// action is about to do to their desktop, so every field it renders is parsed
// here from the permission metadata the computer tools attach and from the tool
// result the session reports once the action has run. The app package cannot
// import the Omnia runtime, so these are structural copies of the shapes in
// docs/computer-use-reliability.md and packages/omnia/src/computer-use/aim.ts.

export type ComputerUseAimStrategy =
  | "control-center"
  | "focus-point"
  | "role-inset"
  | "provider-hint"
  | "bounds-center"

export interface ComputerUsePoint {
  readonly x: number
  readonly y: number
}

export interface ComputerUseBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface ComputerUseAim extends ComputerUsePoint {
  readonly strategy: ComputerUseAimStrategy
}

/** What the agent resolved to act on. Absent fields stay absent: the approval
 *  surface reports exactly what is known instead of inventing the rest. */
export interface ComputerUseTarget {
  readonly ref?: string
  readonly role?: string
  readonly name?: string
  readonly application?: string
  readonly bounds?: ComputerUseBounds
  readonly aim?: ComputerUseAim
}

export interface ComputerUseApproval {
  readonly operation: string
  readonly action?: string
  readonly query?: string
  readonly app?: string
  readonly text?: string
  readonly target: ComputerUseTarget
}

/** Only `verified` means the action was confirmed by a post-action
 *  observation. `unverified` and `failed` are not a pass either. */
export type ComputerUseOutcomeStatus = "verified" | "not_verified" | "unverified" | "failed"

export interface ComputerUseOutcome {
  readonly status: ComputerUseOutcomeStatus
  readonly action?: string
  readonly targetName?: string
  /** What the post-action observation actually showed, when it said anything. */
  readonly observed?: string
  readonly reason?: string
}

export interface ComputerUsePreviewRequest {
  readonly ref?: string
  readonly role?: string
  readonly name?: string
  readonly bounds: ComputerUseBounds
  readonly aim?: ComputerUseAim
}

const AIM_STRATEGIES: ReadonlySet<string> = new Set([
  "control-center",
  "focus-point",
  "role-inset",
  "provider-hint",
  "bounds-center",
])

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function point(value: unknown): ComputerUsePoint | undefined {
  const raw = record(value)
  if (raw === undefined) return
  const x = finite(raw.x)
  const y = finite(raw.y)
  if (x === undefined || y === undefined) return
  return { x, y }
}

function boundsOf(value: unknown): ComputerUseBounds | undefined {
  const raw = record(value)
  if (raw === undefined) return
  const x = finite(raw.x)
  const y = finite(raw.y)
  const width = finite(raw.width)
  const height = finite(raw.height)
  if (x === undefined || y === undefined || width === undefined || height === undefined) return
  return { x, y, width, height }
}

function aimOf(value: unknown): ComputerUseAim | undefined {
  const at = point(value)
  const raw = record(value)
  const strategy = raw === undefined ? undefined : text(raw.strategy)
  if (at === undefined || strategy === undefined || !AIM_STRATEGIES.has(strategy)) return
  return { x: at.x, y: at.y, strategy: strategy as ComputerUseAimStrategy }
}

function targetOf(value: unknown): ComputerUseTarget {
  const ref = text(value)
  if (ref !== undefined) return { ref }
  const raw = record(value)
  if (raw === undefined) return {}
  return {
    ref: text(raw.ref) ?? text(raw.id) ?? text(raw.elementId),
    role: text(raw.role),
    name: text(raw.name) ?? text(raw.accessibleName) ?? text(raw.label),
    application: text(raw.application),
    bounds: boundsOf(raw.bounds),
    aim: aimOf(raw.aim),
  }
}

export function parseComputerUseApproval(input: {
  permission: string
  metadata: unknown
}): ComputerUseApproval | undefined {
  if (input.permission !== "computer") return
  const raw = record(input.metadata)
  const operation = raw === undefined ? undefined : text(raw.operation)
  if (raw === undefined || operation === undefined) return
  // `target` is normally the element ref the model asked for. A producer that
  // also attaches the resolved control carries the role, name and aim here, and
  // those win over anything the model declared.
  const resolved = record(raw.element) ?? record(raw.resolved)
  const declared = targetOf(raw.target)
  const control = resolved === undefined ? {} : targetOf(resolved)
  return {
    operation,
    action: text(raw.action),
    query: text(raw.query),
    app: text(raw.app),
    text: text(raw.text),
    target: {
      ref: control.ref ?? declared.ref,
      role: control.role ?? declared.role,
      name: control.name ?? declared.name,
      application: control.application ?? declared.application,
      bounds: control.bounds ?? declared.bounds,
      aim: control.aim ?? declared.aim,
    },
  }
}

export function computerUseAimIsGuess(aim: ComputerUseAim | undefined): boolean {
  return aim?.strategy === "bounds-center"
}

/** A tool result never counts as verified unless it says so; the tool reports
 *  `unverified` when nothing confirmed the action took effect. */
export function computerUseOutcomeIsVerified(outcome: ComputerUseOutcome | undefined): boolean {
  return outcome?.status === "verified"
}

function observedFromOutput(output: string | undefined): string | undefined {
  if (output === undefined) return
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.startsWith("observed change:") ||
        line.startsWith("verification:") ||
        // A batch plan reports each step's own verdict, which is the only
        // observation it leaves behind.
        /^\d+\.\s/.test(line),
    )
  if (lines.length === 0) return
  return lines.join("\n")
}

export function parseComputerUseOutcome(part: {
  metadata?: unknown
  output?: string
}): ComputerUseOutcome | undefined {
  const raw = record(part.metadata)
  if (raw === undefined) return
  // A tool that reports no verdict has not been verified. Reading one between
  // the lines here would hand the dock a green check nothing earned.
  const status = text(raw.verification) ?? (raw.success === false ? "failed" : "unverified")
  return {
    status: status as ComputerUseOutcomeStatus,
    action: text(raw.action),
    targetName: text(raw.targetName),
    observed: observedFromOutput(part.output),
    reason: text(raw.reason),
  }
}

const COMPUTER_USE_COPY = {
  "target.section": "Computer use",
  "target.action": "Action",
  "target.ref": "Ref",
  "target.role": "Role",
  "target.name": "Name",
  "target.application": "App",
  "target.point": "Point",
  "target.pointValue": "{{x}}, {{y}} ({{strategy}})",
  "target.query": "Query",
  "target.unresolved": "The control this action resolved to could not be read back, so no target is shown.",
  "guess.badge": "guess — not a resolved control",
  "guess.explain":
    "No focus point, provider hint or role inset was available, so the action aims at the centre of the element's bounds.",
  "preview.label": "Highlight target",
  "preview.hint": "Hover or focus to show exactly where the agent will act.",
  "preview.unavailable": "Target highlighting is unavailable on this platform.",
  "outcome.section": "Last action",
  "outcome.verified": "Verified",
  "outcome.notVerified": "Not verified",
  "outcome.unverified": "Unverified",
  "outcome.failed": "Failed",
  "outcome.pending": "Waiting for the action to finish…",
  "outcome.observed": "Observed",
  "outcome.none": "Nothing was observed after the action.",
} as const

export type ComputerUseCopyKey = keyof typeof COMPUTER_USE_COPY

function fill(template: string, params: Record<string, string | number> | undefined): string {
  if (params === undefined) return template
  return template.replace(/{{\s*(\w+)\s*}}/g, (match, key: string) => {
    const value = params[key]
    return value === undefined ? match : String(value)
  })
}

/**
 * Copy for the computer-use approval surface. These keys are new, so they are
 * declared here with their English source text and resolved through the typed
 * i18n API; the shared dictionary wins as soon as it carries the key.
 */
export function computerUseCopy(
  t: (key: string, params?: Record<string, string | number | boolean>) => string | undefined,
  key: ComputerUseCopyKey,
  params?: Record<string, string | number>,
): string {
  const translated = t(`computerUse.permission.${key}`, params)
  if (typeof translated === "string" && translated.length > 0) return translated
  return fill(COMPUTER_USE_COPY[key], params)
}

export interface ComputerUsePlatform {
  models(): Promise<ComputerUseModelStatus[]>
  status(): Promise<ComputerUseStatus>
  settings(): Promise<ComputerUseSettings>
  updateSettings(patch: Partial<ComputerUseSettings>): Promise<ComputerUseSettings>
  download(id: string): Promise<boolean>
  load(id: string): Promise<ComputerUseModelStatus | undefined>
  unload(id: string): Promise<boolean>
  remove(id: string): Promise<boolean>
  runtimes(): Promise<ComputerUseRuntimeStatus[]>
  downloadRuntime(id: string): Promise<boolean>
  removeRuntime(id: string): Promise<boolean>
  calibration(): Promise<ComputerUseCalibrationStatus>
  calibrationStart(): Promise<{ screen: { width: number; height: number }; points: ComputerUseCalibrationPoint[] }>
  calibrationMeasure(pointId: string): Promise<ComputerUseCalibrationMeasurement>
  calibrationSave(measurements: ComputerUseCalibrationMeasurement[]): Promise<ComputerUseCalibrationProfile>
  calibrationReset(): Promise<boolean>

  /**
   * Read back the control a pending computer-use action resolved to, so the
   * approval surface can show its ref, role, name and the aim point the action
   * will actually use. Local only: the desktop resolves it from its own driver.
   * A semantic query is never accepted here, because matching one to a control
   * is the guess the approval surface exists to expose.
   */
  resolveTarget(input: { ref?: string; app?: string }): Promise<ComputerUseTarget | undefined>

  /** Highlight the target bounds on screen so a human can see where the agent
   *  will act. Opt-in: only a computer-use permission ever asks for it. */
  preview(request: ComputerUsePreviewRequest): Promise<void>

  /** Drop the highlight. Called when the pending item loses hover or focus. */
  clearPreview(): Promise<void>
}
