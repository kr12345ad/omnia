import { describe, expect, test } from "bun:test"
import { animatedNumberStep } from "./animated-number"

// The digit is only on screen while the offset points at a cell in `[10, 20)`; `TRACK` maps cell
// index to digit with `index % 10`, so an offset in that window always shows the current digit.
const cellDigit = (offset: number) => offset % 10
const inWindow = (offset: number) => offset >= 10 && offset < 20

describe("animatedNumberStep", () => {
  test("spins inside the cell window when motion is allowed", () => {
    expect(animatedNumberStep({ step: 13, from: 3, to: 5, direction: 1, reducedMotion: false })).toEqual({
      step: 15,
      animating: true,
    })
    expect(animatedNumberStep({ step: 15, from: 5, to: 3, direction: -1, reducedMotion: false })).toEqual({
      step: 13,
      animating: true,
    })
  })

  test("snaps unchanged digits without animating", () => {
    expect(animatedNumberStep({ step: 14, from: 4, to: 4, direction: 1, reducedMotion: false })).toEqual({
      step: 14,
      animating: false,
    })
  })

  test("reduced motion snaps every change instead of accumulating offsets", () => {
    let step = 10
    let from = 0

    for (let index = 1; index <= 40; index += 1) {
      const to = index % 10
      const update = animatedNumberStep({
        step,
        from,
        to,
        direction: to >= from ? 1 : -1,
        reducedMotion: true,
      })
      step = update.step
      from = to
      expect(update.animating).toBe(false)
      expect(inWindow(step)).toBe(true)
      expect(cellDigit(step)).toBe(to)
    }
  })

  test("a missed transitionend cannot push the offset out of the window", () => {
    let step = 10
    let from = 0

    for (let index = 1; index <= 40; index += 1) {
      const to = (index * 7) % 10
      step = animatedNumberStep({
        step,
        from,
        to,
        direction: to >= from ? 1 : -1,
        reducedMotion: false,
      }).step
      from = to
      expect(inWindow(step)).toBe(true)
      expect(cellDigit(step)).toBe(to)
    }
  })

  test("snaps back to the window when an accumulated offset would escape it", () => {
    expect(animatedNumberStep({ step: 29, from: 9, to: 1, direction: 1, reducedMotion: false })).toEqual({
      step: 11,
      animating: false,
    })
    expect(animatedNumberStep({ step: 10, from: 0, to: 9, direction: -1, reducedMotion: false })).toEqual({
      step: 19,
      animating: false,
    })
  })
})
