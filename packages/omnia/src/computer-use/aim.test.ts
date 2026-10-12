import { describe, expect, test } from "bun:test"
import { computeAim, isCenterGuess } from "./aim"

describe("computeAim", () => {
  test("textfield resolves control-center at the centre of its bounds", () => {
    const aim = computeAim({ bounds: { x: 10, y: 40, width: 100, height: 24 }, role: "textfield" })
    expect(aim).toEqual({ x: 60, y: 52, strategy: "control-center" })
    expect(isCenterGuess(aim)).toBe(false)
  })

  test("title-bar close button insets away from the centre", () => {
    const bounds = { x: 1843, y: 45, width: 46, height: 32 }
    const aim = computeAim({ bounds, role: "close" })
    expect(aim.strategy).toBe("role-inset")
    expect(aim.x).toBe(1883)
    expect(aim.y).toBe(61)
    expect(aim.x).toBeGreaterThan(bounds.x + bounds.width / 2)
    expect(aim.x).toBeLessThanOrEqual(bounds.x + bounds.width)
  })

  test("title-bar minimize button insets towards the opposite edge", () => {
    const bounds = { x: 1834, y: 45, width: 46, height: 32 }
    const aim = computeAim({ bounds, role: "minimize" })
    expect(aim.strategy).toBe("role-inset")
    expect(aim.x).toBe(1840)
    expect(aim.y).toBe(61)
    expect(aim.x).toBeLessThan(bounds.x + bounds.width / 2)
    expect(aim.x).toBeGreaterThanOrEqual(bounds.x)
  })

  test("minimize and close never resolve to the same point", () => {
    const close = computeAim({ bounds: { x: 1843, y: 45, width: 46, height: 32 }, role: "close" })
    const minimize = computeAim({ bounds: { x: 1834, y: 45, width: 46, height: 32 }, role: "minimize" })
    expect(Math.abs(close.x - minimize.x)).toBeGreaterThan(25)
  })

  test("focus point beats a role inset", () => {
    const aim = computeAim({
      bounds: { x: 1843, y: 45, width: 46, height: 32 },
      role: "close",
      focusPoint: { x: 1850, y: 55 },
    })
    expect(aim).toEqual({ x: 1850, y: 55, strategy: "focus-point" })
  })

  test("provider hint beats focus point and role", () => {
    const aim = computeAim({
      bounds: { x: 10, y: 40, width: 100, height: 24 },
      role: "textfield",
      focusPoint: { x: 30, y: 50 },
      aimHint: { x: 80, y: 58 },
    })
    expect(aim).toEqual({ x: 80, y: 58, strategy: "provider-hint" })
  })

  test("null focus point and null hint are ignored, not treated as 0,0", () => {
    const aim = computeAim({
      bounds: { x: 10, y: 40, width: 100, height: 24 },
      role: "button",
      focusPoint: null,
      aimHint: null,
    })
    expect(aim).toEqual({ x: 60, y: 52, strategy: "control-center" })
  })

  test("unknown role without hints falls back to bounds-center and is flagged as a guess", () => {
    const aim = computeAim({ bounds: { x: 400, y: 300, width: 200, height: 80 }, role: "panel" })
    expect(aim).toEqual({ x: 500, y: 340, strategy: "bounds-center" })
    expect(isCenterGuess(aim)).toBe(true)
  })

  test("missing role falls back to bounds-center", () => {
    const aim = computeAim({ bounds: { x: 0, y: 0, width: 10, height: 10 } })
    expect(aim.strategy).toBe("bounds-center")
    expect(isCenterGuess(aim)).toBe(true)
  })

  test("points outside the bounds are clamped back inside", () => {
    const bounds = { x: 10, y: 40, width: 100, height: 24 }
    expect(computeAim({ bounds, focusPoint: { x: 5000, y: -100 } })).toEqual({
      x: 110,
      y: 40,
      strategy: "focus-point",
    })
    expect(computeAim({ bounds, aimHint: { x: -5000, y: 1000 } })).toEqual({
      x: 10,
      y: 64,
      strategy: "provider-hint",
    })
    expect(computeAim({ bounds, role: "close" })).toEqual({ x: 98, y: 52, strategy: "role-inset" })
  })
})
