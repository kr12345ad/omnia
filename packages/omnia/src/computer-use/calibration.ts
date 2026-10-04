import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { ActionResult, ComputerAction } from "../protocol"

// Display calibration measures how raw pointer input maps to screen pixels by
// driving the pointer to known points and reading the position back. The
// resulting affine correction (scale + offset per axis) is applied to every
// point-targeted action, which repairs DPI scaling, multi-monitor offsets,
// and compositor coordinate quirks.

// A profile older than this is treated as stale even when the screen size
// matches: monitor scaling/arrangement drifts over time.
export const CALIBRATION_TTL_MS = 30 * 86400000
// An affine fit needs at least three samples to have a residual to sanity
// check; a single sample is indistinguishable from a typo.
export const MIN_CALIBRATION_SAMPLES = 3
// Residuals above this many pixels are not display noise: the sample is an
// outlier (e.g. a readback from a different monitor) and must not drag the fit.
// Tightened for the logical-pixel contract: a 12px device residual is 6px
// logical on Retina, so the fit rejects above 8px to keep vision clicks safe.
export const MAX_CALIBRATION_RESIDUAL_PX = 8
// A caller can measure repeatedly without begin()/commit(); the buffer is
// capped so it cannot grow without bound.
export const MAX_CALIBRATION_PENDING = 64
// Sanity range for the fitted scale. Values outside this are not a display
// correction, they are a broken measurement.
export const MIN_CALIBRATION_SCALE = 0.2
export const MAX_CALIBRATION_SCALE = 5

export interface CalibrationPoint {
  readonly id: string
  readonly x: number
  readonly y: number
}

export interface CalibrationMeasurement {
  readonly pointId: string
  readonly x: number
  readonly y: number
  readonly observedX?: number
  readonly observedY?: number
  readonly deltaX?: number
  readonly deltaY?: number
  readonly error?: string
}

export interface CalibrationProfile {
  readonly screen: { width: number; height: number }
  readonly scaleX: number
  readonly scaleY: number
  readonly offsetX: number
  readonly offsetY: number
  readonly samples: number
  readonly measuredAt: number
}

export interface CalibrationStatus {
  readonly profile?: CalibrationProfile
  readonly screen?: { width: number; height: number }
  readonly stale: boolean
  readonly calibrated: boolean
}

export interface CalibrationDriver {
  execute(action: ComputerAction): Promise<ActionResult>
  pointerPosition?(): Promise<ActionResult & { x?: number; y?: number; held?: boolean }>
}

export interface CalibrationManagerOptions {
  readonly file?: string
  readonly now?: () => number
  readonly points?: number
}

export function calibrationFile(): string {
  return join(homedir(), ".local", "share", "omnia", "calibration.json")
}

export class CalibrationManager {
  private readonly file: string
  private readonly now: () => number
  private readonly points: number
  private profile: CalibrationProfile | undefined
  private pending: CalibrationMeasurement[] = []
  // The last screen the manager was told about (status/grid/measure/commit).
  // transform() uses it to derive staleness even when the caller does not pass
  // a screen, so a stale profile never silently shifts clicks.
  private observedScreen: { width: number; height: number } | undefined

  constructor(options: CalibrationManagerOptions = {}) {
    this.file = options.file ?? calibrationFile()
    this.now = options.now ?? Date.now
    this.points = options.points ?? 9
    this.profile = readProfile(this.file)
  }

  // True when the stored profile cannot be trusted for `screen` (size drift
  // or age). server/api.ts should call this (or pass the screen to transform)
  // before applying calibration to pointer coordinates.
  stale(screen?: { width: number; height: number }): boolean {
    const target = screen ?? this.observedScreen
    const profile = this.profile
    if (profile === undefined) return false
    if (target !== undefined && (profile.screen.width !== target.width || profile.screen.height !== target.height)) return true
    return this.now() - profile.measuredAt > CALIBRATION_TTL_MS
  }

  status(screen?: { width: number; height: number }): CalibrationStatus {
    if (screen !== undefined) this.observedScreen = screen
    const profile = this.profile
    const stale = this.stale(screen)
    return {
      ...(profile === undefined ? {} : { profile }),
      ...(screen === undefined ? {} : { screen }),
      stale,
      calibrated: profile !== undefined && !stale,
    }
  }

  // A 3x3 grid inset from the edges so every point lands inside the display on
  // any aspect ratio and away from screen corners the compositor may reserve.
  grid(screen: { width: number; height: number }): CalibrationPoint[] {
    this.observedScreen = screen
    const inset = 0.1
    const fractions = [inset, 0.5, 1 - inset]
    const count = Math.max(1, Math.min(9, this.points))
    const points: CalibrationPoint[] = []
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        if (points.length >= count) return points
        const x = Math.round(screen.width * fractions[column]!)
        const y = Math.round(screen.height * fractions[row]!)
        points.push({ id: `p${row}${column}`, x, y })
      }
    }
    return points
  }

  begin(): CalibrationPoint[] {
    this.pending = []
    return []
  }

  pendingMeasurements(): readonly CalibrationMeasurement[] {
    return this.pending
  }

  commit(screen: { width: number; height: number }): CalibrationProfile | undefined {
    this.observedScreen = screen
    const profile = this.computeProfile(this.pending, screen)
    if (profile === undefined) return undefined
    const saved = this.save(profile)
    // A committed session must not leave stale pending measurements behind for
    // the next calibration run.
    this.pending = []
    return saved
  }

  async measure(driver: CalibrationDriver, point: CalibrationPoint): Promise<CalibrationMeasurement> {
    // Bound the pending buffer: the oldest measurement is evicted first so a
    // runaway calibration session cannot grow memory without limit.
    if (this.pending.length >= MAX_CALIBRATION_PENDING) this.pending.shift()
    if (driver.pointerPosition === undefined) {
      const failed = { pointId: point.id, x: point.x, y: point.y, error: "pointer_position_unavailable" }
      this.pending.push(failed)
      return failed
    }
    const moved = await driver
      .execute({ type: "move", target: { kind: "point", x: point.x, y: point.y } })
      .catch((error: unknown) => ({ success: false, message: error instanceof Error ? error.message : String(error) }))
    if (moved.success !== true) {
      const failed = { pointId: point.id, x: point.x, y: point.y, error: moved.message ?? "move_failed" }
      this.pending.push(failed)
      return failed
    }
    const position = await driver.pointerPosition().catch(() => undefined)
    if (position?.x === undefined || position.y === undefined) {
      const failed = { pointId: point.id, x: point.x, y: point.y, error: "pointer_readback_failed" }
      this.pending.push(failed)
      return failed
    }
    const measurement = {
      pointId: point.id,
      x: point.x,
      y: point.y,
      observedX: position.x,
      observedY: position.y,
      deltaX: position.x - point.x,
      deltaY: position.y - point.y,
    }
    this.pending.push(measurement)
    return measurement
  }

  // Robust affine fit: a median-of-pairwise-slopes estimate resists a
  // minority of wildly wrong readbacks, samples beyond the residual threshold
  // are dropped, and only then is a least-squares fit run on the inliers.
  // Requires at least MIN_CALIBRATION_SAMPLES inliers and rejects fits whose
  // scale is outside the sanity range. The correction applied at action time
  // is the inverse: expected = (raw - offset) / scale.
  computeProfile(
    measurements: readonly CalibrationMeasurement[],
    screen: { width: number; height: number },
  ): CalibrationProfile | undefined {
    const valid = measurements.filter(
      (entry) =>
        entry.error === undefined &&
        entry.observedX !== undefined &&
        entry.observedY !== undefined,
    )
    if (valid.length < MIN_CALIBRATION_SAMPLES) return undefined
    if (!isScreen(screen)) return undefined
    const xPairs = valid.map((entry) => ({ expected: entry.x, observed: entry.observedX! }))
    const yPairs = valid.map((entry) => ({ expected: entry.y, observed: entry.observedY! }))
    const xRobust = robustFit(xPairs)
    const yRobust = robustFit(yPairs)
    const xThreshold = residualThreshold(xPairs, xRobust)
    const yThreshold = residualThreshold(yPairs, yRobust)
    const inliers = valid.filter(
      (entry, index) =>
        Math.abs(xPairs[index]!.observed - (xRobust.scale * xPairs[index]!.expected + xRobust.offset)) <= xThreshold &&
        Math.abs(yPairs[index]!.observed - (yRobust.scale * yPairs[index]!.expected + yRobust.offset)) <= yThreshold,
    )
    if (inliers.length < MIN_CALIBRATION_SAMPLES) return undefined
    const x = leastSquaresFit(inliers.map((entry) => ({ expected: entry.x, observed: entry.observedX! })))
    const y = leastSquaresFit(inliers.map((entry) => ({ expected: entry.y, observed: entry.observedY! })))
    if (!isScale(x.scale) || !isScale(y.scale) || !Number.isFinite(x.offset) || !Number.isFinite(y.offset)) return undefined
    return {
      screen,
      scaleX: Number(x.scale.toFixed(6)),
      scaleY: Number(y.scale.toFixed(6)),
      offsetX: Number(x.offset.toFixed(3)),
      offsetY: Number(y.offset.toFixed(3)),
      samples: inliers.length,
      measuredAt: this.now(),
    }
  }

  save(profile: CalibrationProfile): CalibrationProfile {
    if (!isValidProfile(profile)) throw new TypeError("Refusing to save an invalid calibration profile.")
    this.profile = profile
    this.observedScreen = profile.screen
    mkdirSync(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp`
    writeFileSync(temporary, JSON.stringify(profile, null, 2), { mode: 0o600 })
    renameSync(temporary, this.file)
    return profile
  }

  reset(): void {
    this.profile = undefined
    this.pending = []
    rmSync(this.file, { force: true })
  }

  // Returns corrected input coordinates for a desired screen pixel. A stale,
  // missing, or invalid profile is a no-op so actions never break on bad
  // calibration. Callers that know the current screen should pass it;
  // otherwise the last screen observed via status()/grid()/commit() is used.
  transform(x: number, y: number, screen?: { width: number; height: number }): { x: number; y: number } {
    const profile = this.profile
    if (profile === undefined) return { x, y }
    const target = screen ?? this.observedScreen
    // Never apply a profile to an unknown screen: without a size to compare
    // against, a stale profile would silently shift every click.
    if (target === undefined) return { x, y }
    if (this.stale(target)) return { x, y }
    if (!isScale(profile.scaleX) || !isScale(profile.scaleY)) return { x, y }
    const corrected = {
      x: Math.round((x - profile.offsetX) / profile.scaleX),
      y: Math.round((y - profile.offsetY) / profile.scaleY),
    }
    if (!Number.isFinite(corrected.x) || !Number.isFinite(corrected.y)) return { x, y }
    return corrected
  }
}

function leastSquaresFit(pairs: readonly { expected: number; observed: number }[]): { scale: number; offset: number } {
  const meanExpected = pairs.reduce((total, pair) => total + pair.expected, 0) / pairs.length
  const meanObserved = pairs.reduce((total, pair) => total + pair.observed, 0) / pairs.length
  const covariance = pairs.reduce((total, pair) => total + (pair.expected - meanExpected) * (pair.observed - meanObserved), 0)
  const variance = pairs.reduce((total, pair) => total + (pair.expected - meanExpected) ** 2, 0)
  const scale = variance === 0 ? 1 : covariance / variance
  return { scale, offset: meanObserved - scale * meanExpected }
}

// Theil-Sen-style estimate: the median pairwise slope is unaffected by a
// minority of gross readback errors (e.g. a monitor that reports device
// pixels) in a way a plain mean is not.
function robustFit(pairs: readonly { expected: number; observed: number }[]): { scale: number; offset: number } {
  const slopes = pairs.flatMap((left, index) =>
    pairs
      .slice(index + 1)
      .filter((right) => right.expected !== left.expected)
      .map((right) => (right.observed - left.observed) / (right.expected - left.expected)),
  )
  const scale = slopes.length === 0 ? 1 : median(slopes)
  const offset = median(pairs.map((pair) => pair.observed - scale * pair.expected))
  return { scale, offset }
}

function residualThreshold(
  pairs: readonly { expected: number; observed: number }[],
  fit: { scale: number; offset: number },
): number {
  const residuals = pairs.map((pair) => Math.abs(pair.observed - (fit.scale * pair.expected + fit.offset)))
  // Twice the median (floored at MAX) resists a minority of gross readbacks
  // without letting a single wild sample inflate the acceptance band the way
  // 3x median did on HiDPI screens.
  return Math.max(MAX_CALIBRATION_RESIDUAL_PX, 2 * median(residuals))
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function isScale(value: number): boolean {
  // A negative scale would invert the axis; only a positive display
  // correction in the sanity range is meaningful.
  return Number.isFinite(value) && value >= MIN_CALIBRATION_SCALE && value <= MAX_CALIBRATION_SCALE
}

function isScreen(value: { width: number; height: number } | undefined): value is { width: number; height: number } {
  return value !== undefined && Number.isFinite(value.width) && Number.isFinite(value.height) && value.width > 0 && value.height > 0
}

function isValidProfile(profile: CalibrationProfile): boolean {
  return (
    isScreen(profile.screen) &&
    isScale(profile.scaleX) &&
    isScale(profile.scaleY) &&
    Number.isFinite(profile.offsetX) &&
    Number.isFinite(profile.offsetY) &&
    Number.isFinite(profile.measuredAt) &&
    profile.measuredAt > 0 &&
    Number.isInteger(profile.samples) &&
    profile.samples >= 1
  )
}

function readProfile(file: string): CalibrationProfile | undefined {
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<CalibrationProfile>
    if (
      typeof parsed.scaleX !== "number" ||
      typeof parsed.scaleY !== "number" ||
      typeof parsed.offsetX !== "number" ||
      typeof parsed.offsetY !== "number" ||
      typeof parsed.measuredAt !== "number" ||
      typeof parsed.screen?.width !== "number" ||
      typeof parsed.screen?.height !== "number"
    ) {
      return undefined
    }
    const profile: CalibrationProfile = {
      screen: { width: parsed.screen.width, height: parsed.screen.height },
      scaleX: parsed.scaleX,
      scaleY: parsed.scaleY,
      offsetX: parsed.offsetX,
      offsetY: parsed.offsetY,
      samples: typeof parsed.samples === "number" ? parsed.samples : 1,
      measuredAt: parsed.measuredAt,
    }
    // Range-check instead of merely type-checking: absurd scales/offsets or a
    // zero sample count must never be applied to clicks.
    return isValidProfile(profile) ? profile : undefined
  } catch {
    return undefined
  }
}
