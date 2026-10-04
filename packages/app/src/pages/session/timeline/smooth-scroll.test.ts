import { describe, expect, test } from "bun:test"
import { clampScrollTop, createSmoothScroll } from "./smooth-scroll"

function element(input: { scrollTop?: number; scrollHeight?: number; clientHeight?: number }): HTMLElement {
  return {
    scrollTop: input.scrollTop ?? 0,
    scrollHeight: input.scrollHeight ?? 1000,
    clientHeight: input.clientHeight ?? 400,
  } as HTMLElement
}

describe("smooth scroll", () => {
  test("clamps the target to the scrollable range", () => {
    const el = element({ scrollHeight: 1000, clientHeight: 400 })
    expect(clampScrollTop(el, -50)).toBe(0)
    expect(clampScrollTop(el, 600)).toBe(600)
    expect(clampScrollTop(el, 5000)).toBe(600)
  })

  test("sets the position directly when motion is reduced or unavailable", () => {
    const el = element({ scrollTop: 100, scrollHeight: 1000, clientHeight: 400 })
    const scroller = createSmoothScroll(() => el, { reducedMotion: () => true })
    scroller.to(700)
    expect(el.scrollTop).toBe(600)
    expect(scroller.animating()).toBe(false)
  })

  test("toEnd targets the bottom of the scroll range", () => {
    const el = element({ scrollTop: 0, scrollHeight: 900, clientHeight: 400 })
    const scroller = createSmoothScroll(() => el, { reducedMotion: () => true })
    scroller.toEnd()
    expect(el.scrollTop).toBe(500)
  })

  test("does nothing without an element", () => {
    const scroller = createSmoothScroll(() => null)
    expect(() => scroller.to(100)).not.toThrow()
    expect(scroller.animating()).toBe(false)
  })
})
