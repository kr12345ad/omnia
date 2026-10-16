import { describe, expect, test } from "bun:test"
import {
  canScrollFrame,
  frameScrollBridge,
  frameScrollChannel,
  readFrameScrollBox,
  wheelScrollDelta,
  type FrameScrollBox,
} from "./frame-scroll"

// A card 900px tall in a 300px box: its own scroll box, which is what the app
// and the frame argue over.
const box: FrameScrollBox = { scrollTop: 0, scrollHeight: 900, clientHeight: 300 }

describe("frame scroll channels", () => {
  test("every channel is named after the component that owns the frame", () => {
    expect(frameScrollChannel("openui-js-card", "state")).toBe("openui-js-card-scroll-state")
    expect(frameScrollChannel("openui-js-card", "scroll")).toBe("openui-js-card-scroll")
    expect(frameScrollChannel("openui-js-card", "overflow")).toBe("openui-js-card-scroll-overflow")
  })
})

describe("readFrameScrollBox", () => {
  test("keeps a report whose three numbers are numbers", () => {
    expect(readFrameScrollBox({ type: "openui-js-card-scroll-state", ...box })).toEqual(box)
  })

  test("refuses a report it cannot trust", () => {
    expect(readFrameScrollBox(undefined)).toBeUndefined()
    expect(readFrameScrollBox("openui-js-card-scroll-state")).toBeUndefined()
    expect(readFrameScrollBox({ scrollTop: "0", scrollHeight: 900, clientHeight: 300 })).toBeUndefined()
    expect(readFrameScrollBox({ scrollTop: 0, scrollHeight: Number.NaN, clientHeight: 300 })).toBeUndefined()
    expect(readFrameScrollBox({ scrollTop: 0, scrollHeight: 900 })).toBeUndefined()
  })
})

describe("canScrollFrame", () => {
  test("holds the gesture while the box can still move that way", () => {
    expect(canScrollFrame(box, 120)).toBe(true)
    expect(canScrollFrame({ ...box, scrollTop: 600 }, -120)).toBe(true)
  })

  test("hands it back at either edge of the box", () => {
    expect(canScrollFrame({ ...box, scrollTop: 600 }, 120)).toBe(false)
    expect(canScrollFrame(box, -120)).toBe(false)
    expect(canScrollFrame(box, 0)).toBe(false)
  })

  test("treats a fractional end as the end", () => {
    expect(canScrollFrame({ scrollTop: 599.5, scrollHeight: 900, clientHeight: 300 }, 120)).toBe(false)
  })
})

describe("wheelScrollDelta", () => {
  test("is pixels, which is what a frame scrolls by", () => {
    expect(wheelScrollDelta({ deltaY: 24, deltaMode: 0 }, 400)).toBe(24)
    expect(wheelScrollDelta({ deltaY: 3, deltaMode: 1 }, 400)).toBe(120)
    expect(wheelScrollDelta({ deltaY: -1, deltaMode: 2 }, 400)).toBe(-400)
  })
})

describe("frameScrollBridge", () => {
  const bridge = frameScrollBridge("openui-js-card")

  test("carries the three channels the two halves agree on", () => {
    expect(bridge).toContain("openui-js-card-scroll-state")
    expect(bridge).toContain("openui-js-card-scroll")
    expect(bridge).toContain("openui-js-card-scroll-overflow")
    expect(bridge).toContain("postMessage")
  })

  test("stops the browser from scrolling the frame instead of the app", () => {
    // The frame only finds out a gesture is its own if the browser was stopped
    // from treating it as its own.
    expect(bridge).toContain("{passive:false}")
    expect(bridge).toContain("preventDefault")
  })

  test("scrolls the box it reported, whatever that box is", () => {
    expect(bridge).toContain("getComputedStyle")
    expect(bridge).toContain("overflowY")
    expect(bridge).toContain("ResizeObserver")
  })
})
