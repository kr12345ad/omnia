import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CalibrationManager, type CalibrationDriver } from "./calibration"
import type { ActionResult, ComputerAction } from "../protocol"

function driver(observed: { x: number; y: number } | undefined): CalibrationDriver {
  return {
    execute: async (_action: ComputerAction): Promise<ActionResult> => ({
      success: true,
      status: "success",
      message: "moved",
    }),
    pointerPosition: async () => ({
      success: true,
      status: "success",
      message: "position",
      ...(observed === undefined ? {} : { x: observed.x, y: observed.y }),
    }),
  }
}

function manager() {
  return new CalibrationManager({ file: join(mkdtempSync(join(tmpdir(), "omnia-cal-")), "calibration.json") })
}

describe("display calibration", () => {
  test("grid stays inside the display and is deterministic", () => {
    const calibration = manager()
    const points = calibration.grid({ width: 1920, height: 1080 })
    expect(points).toHaveLength(9)
    expect(points[0]).toEqual({ id: "p00", x: 192, y: 108 })
    expect(points[4]).toEqual({ id: "p11", x: 960, y: 540 })
    expect(points[8]).toEqual({ id: "p22", x: 1728, y: 972 })
  })

  test("measures pointer readback deltas", async () => {
    const calibration = manager()
    const measurement = await calibration.measure(driver({ x: 4, y: 18 }), { id: "p00", x: 4, y: 4 })
    expect(measurement.deltaX).toBe(0)
    expect(measurement.deltaY).toBe(14)
  })

  test("computes and applies an affine correction", () => {
    const calibration = manager()
    const profile = calibration.computeProfile(
      [
        { pointId: "p00", x: 100, y: 100, observedX: 100, observedY: 114 },
        { pointId: "p11", x: 960, y: 540, observedX: 960, observedY: 554 },
        { pointId: "p22", x: 1728, y: 972, observedX: 1728, observedY: 986 },
      ],
      { width: 1920, height: 1080 },
    )
    expect(profile).toBeDefined()
    expect(profile!.scaleX).toBeCloseTo(1, 5)
    expect(profile!.scaleY).toBeCloseTo(1, 5)
    expect(profile!.offsetY).toBeCloseTo(14, 3)
    calibration.save(profile!)
    expect(calibration.transform(500, 500)).toEqual({ x: 500, y: 486 })
  })

  test("flags a stale profile when the display size changes", () => {
    const calibration = manager()
    const profile = calibration.computeProfile(
      [
        { pointId: "p00", x: 100, y: 100, observedX: 100, observedY: 100 },
        { pointId: "p11", x: 960, y: 540, observedX: 960, observedY: 540 },
        { pointId: "p22", x: 1728, y: 972, observedX: 1728, observedY: 972 },
      ],
      { width: 1920, height: 1080 },
    )!
    calibration.save(profile)
    expect(calibration.status({ width: 1920, height: 1080 }).stale).toBe(false)
    expect(calibration.status({ width: 2560, height: 1440 }).stale).toBe(true)
    expect(calibration.transform(100, 100, { width: 2560, height: 1440 })).toEqual({ x: 100, y: 100 })
  })

  test("reset clears the profile", () => {
    const calibration = manager()
    const profile = calibration.computeProfile(
      [
        { pointId: "p00", x: 100, y: 100, observedX: 100, observedY: 100 },
        { pointId: "p11", x: 960, y: 540, observedX: 960, observedY: 540 },
        { pointId: "p22", x: 1728, y: 972, observedX: 1728, observedY: 972 },
      ],
      { width: 1920, height: 1080 },
    )!
    calibration.save(profile)
    expect(calibration.status().calibrated).toBe(true)
    calibration.reset()
    expect(calibration.status().calibrated).toBe(false)
  })
})
import { statSync, writeFileSync } from "node:fs"
import { CALIBRATION_TTL_MS, MAX_CALIBRATION_PENDING, MIN_CALIBRATION_SAMPLES } from "./calibration"

describe("display calibration hardening", () => {
  const samples = [
    { pointId: "p00", x: 100, y: 100, observedX: 100, observedY: 114 },
    { pointId: "p11", x: 960, y: 540, observedX: 960, observedY: 554 },
    { pointId: "p22", x: 1728, y: 972, observedX: 1728, observedY: 986 },
  ]

  test("requires at least three samples", () => {
    const calibration = manager()
    expect(MIN_CALIBRATION_SAMPLES).toBe(3)
    expect(calibration.computeProfile(samples.slice(0, 2), { width: 1920, height: 1080 })).toBeUndefined()
    expect(calibration.computeProfile(samples, { width: 1920, height: 1080 })).toBeDefined()
  })

  test("rejects a negative or absurd scale", () => {
    const calibration = manager()
    const profile = calibration.computeProfile(
      [
        { pointId: "p00", x: 100, y: 100, observedX: 300, observedY: 300 },
        { pointId: "p11", x: 200, y: 200, observedX: 200, observedY: 200 },
        { pointId: "p22", x: 300, y: 300, observedX: 100, observedY: 100 },
      ],
      { width: 1920, height: 1080 },
    )
    expect(profile).toBeUndefined()
  })

  test("a profile for another screen is never applied when the screen changes", () => {
    const calibration = manager()
    calibration.save(calibration.computeProfile(samples, { width: 1920, height: 1080 })!)
    // The API observes the real screen through status(); transform must then
    // derive staleness even though the caller passed no screen.
    calibration.status({ width: 2560, height: 1440 })
    expect(calibration.stale()).toBe(true)
    expect(calibration.transform(500, 500)).toEqual({ x: 500, y: 500 })
  })

  test("transform is a no-op when no screen has ever been observed", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-cal-"))
    const file = join(dir, "calibration.json")
    writeFileSync(
      file,
      JSON.stringify({
        screen: { width: 1920, height: 1080 },
        scaleX: 1,
        scaleY: 1,
        offsetX: 0,
        offsetY: 20,
        samples: 3,
        measuredAt: Date.now(),
      }),
    )
    const calibration = new CalibrationManager({ file })
    expect(calibration.transform(500, 500)).toEqual({ x: 500, y: 500 })
  })

  test("a profile older than the TTL is stale", () => {
    let now = 1_000_000_000_000
    const calibration = new CalibrationManager({
      file: join(mkdtempSync(join(tmpdir(), "omnia-cal-")), "calibration.json"),
      now: () => now,
    })
    calibration.save(calibration.computeProfile(samples, { width: 1920, height: 1080 })!)
    expect(calibration.stale({ width: 1920, height: 1080 })).toBe(false)
    now += CALIBRATION_TTL_MS + 1
    expect(calibration.stale({ width: 1920, height: 1080 })).toBe(true)
    expect(calibration.transform(500, 500)).toEqual({ x: 500, y: 500 })
  })

  test("readProfile rejects out-of-range values", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-cal-"))
    const file = join(dir, "calibration.json")
    writeFileSync(
      file,
      JSON.stringify({
        screen: { width: 1920, height: 1080 },
        scaleX: 0.001,
        scaleY: 1,
        offsetX: 0,
        offsetY: 0,
        samples: 3,
        measuredAt: Date.now(),
      }),
    )
    expect(new CalibrationManager({ file }).status().profile).toBeUndefined()
  })

  test("save writes atomically with owner-only permissions", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-cal-"))
    const file = join(dir, "calibration.json")
    const calibration = new CalibrationManager({ file })
    calibration.save(calibration.computeProfile(samples, { width: 1920, height: 1080 })!)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test("commit clears pending measurements", async () => {
    const calibration = manager()
    const points = calibration.grid({ width: 1920, height: 1080 })
    for (const point of points.slice(0, 3)) {
      await calibration.measure(driver({ x: point.x + 4, y: point.y + 6 }), point)
    }
    expect(calibration.pendingMeasurements()).toHaveLength(3)
    const profile = calibration.commit({ width: 1920, height: 1080 })
    expect(profile).toBeDefined()
    expect(calibration.pendingMeasurements()).toHaveLength(0)
  })

  test("rejects outlier measurements instead of averaging them into the fit", () => {
    const calibration = manager()
    const points = calibration.grid({ width: 1920, height: 1080 })
    const measurements = points.map((point) => ({
      pointId: point.id,
      x: point.x,
      y: point.y,
      observedX: point.x,
      observedY: point.y,
    }))
    measurements[4] = { ...measurements[4]!, observedX: 5000, observedY: 5000 }
    const profile = calibration.computeProfile(measurements, { width: 1920, height: 1080 })
    expect(profile).toBeDefined()
    expect(profile!.samples).toBe(8)
    expect(profile!.scaleX).toBeCloseTo(1, 3)
    expect(profile!.scaleY).toBeCloseTo(1, 3)
    expect(profile!.offsetX).toBeCloseTo(0, 3)
    expect(profile!.offsetY).toBeCloseTo(0, 3)
  })

  test("rejects a session when too few measurements survive outlier rejection", () => {
    const calibration = manager()
    const profile = calibration.computeProfile(
      [
        { pointId: "a", x: 100, y: 100, observedX: 100, observedY: 100 },
        { pointId: "b", x: 500, y: 500, observedX: 9000, observedY: 9000 },
        { pointId: "c", x: 900, y: 900, observedX: 900, observedY: 900 },
      ],
      { width: 1920, height: 1080 },
    )
    expect(profile).toBeUndefined()
  })

  test("caps the pending measurement buffer", async () => {
    const calibration = manager()
    for (let index = 0; index < MAX_CALIBRATION_PENDING + 5; index += 1) {
      await calibration.measure(driver({ x: index, y: index }), { id: `p${index}`, x: index, y: index })
    }
    const pending = calibration.pendingMeasurements()
    expect(pending).toHaveLength(MAX_CALIBRATION_PENDING)
    expect(pending[0]?.pointId).toBe("p5")
    expect(pending[pending.length - 1]?.pointId).toBe(`p${MAX_CALIBRATION_PENDING + 4}`)
  })
})
