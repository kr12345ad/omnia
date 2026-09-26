import { describe, expect, test } from "bun:test"
import {
  buildObservation,
  displayName,
  mapActionName,
  parseActiveWindowId,
  parseAtspiReference,
  parseWindowIds,
  parseXdpyinfo,
  parseXprop,
  parseXrandr,
  parseXwininfo,
  splitCommand,
  summarizeObservation,
  windowToElement,
} from "./linux"
import type { AtspiApplication, X11Window } from "./linux"

const CLIENT_LIST = `_NET_CLIENT_LIST(WINDOW): window id # 0x1a00011, 0x7400009, 0x5c0000b
`

const ACTIVE = `_NET_ACTIVE_WINDOW(WINDOW): window id # 0x7400009
`

const PROPS = `WM_CLASS(STRING) = "Navigator", "firefox"
WM_NAME(COMPOUND_TEXT) = "Example page — Mozilla Firefox"
_NET_WM_PID(CARDINAL) = 4242
`

const GEOM = `  Absolute upper-left X:  0
  Absolute upper-left Y:  28
  Width: 1920
  Height: 1022
`

const windowFixture: X11Window = {
  id: "0x7400009",
  instance: "Navigator",
  cls: "firefox",
  title: "Example page",
  pid: 4242,
  active: true,
  x: 0,
  y: 28,
  width: 1920,
  height: 1022,
}

const appFixture: AtspiApplication = {
  name: "firefox",
  nodes: [
    {
      path: [3],
      role: "frame",
      name: "Example page",
      states: ["enabled", "focused"],
      actions: [],
      children: [
        {
          path: [3, 5],
          role: "pushbutton",
          name: "Export",
          states: ["enabled"],
          actions: ["click"],
          bounds: { x: 10, y: 20, width: 80, height: 24 },
          children: [],
        },
      ],
    },
  ],
}

describe("linux host parsing", () => {
  test("parses client list window ids", () => {
    expect(parseWindowIds(CLIENT_LIST)).toEqual(["0x1a00011", "0x7400009", "0x5c0000b"])
    expect(parseWindowIds("nothing here")).toEqual([])
  })

  test("parses the active window and ignores 0x0", () => {
    expect(parseActiveWindowId(ACTIVE)).toBe("0x7400009")
    expect(parseActiveWindowId("_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0")).toBeUndefined()
  })

  test("parses window properties", () => {
    expect(parseXprop(PROPS)).toEqual({ instance: "Navigator", cls: "firefox", title: "Example page — Mozilla Firefox", pid: 4242 })
  })

  test("parses window geometry", () => {
    expect(parseXwininfo(GEOM)).toEqual({ x: 0, y: 28, width: 1920, height: 1022 })
  })

  test("parses screen geometry from xrandr and xdpyinfo", () => {
    const xrandr = `Screen 0: minimum 16 x 16, current 1920 x 1080, maximum 32767 x 32767
eDP-1 connected primary 1920x1080+0+0 (normal left inverted right x axis y axis) 344mm x 193mm
`
    expect(parseXrandr(xrandr)).toEqual({ width: 1920, height: 1080 })
    expect(parseXrandr("eDP-1 disconnected (normal)")).toBeUndefined()
    expect(parseXdpyinfo("  dimensions:    1920x1080 pixels (508x285 millimeters)")).toEqual({ widthMm: 508, heightMm: 285 })
    expect(parseXdpyinfo("no dimensions here")).toBeUndefined()
  })

  test("derives display names with fallbacks", () => {
    expect(displayName(windowFixture)).toBe("Example page")
    expect(displayName({ id: "0x1", instance: "", cls: "xterm", title: "" })).toBe("xterm")
  })

  test("parses AT-SPI references and rejects garbage", () => {
    expect(parseAtspiReference("atspi:3.5.0")).toEqual([3, 5, 0])
    expect(parseAtspiReference("x11:0x1")).toBeUndefined()
    expect(parseAtspiReference("atspi:3.x")).toBeUndefined()
  })

  test("maps click-like AT-SPI actions", () => {
    expect(mapActionName("click")).toBe("click")
    expect(mapActionName("Press")).toBe("click")
    expect(mapActionName("jump")).toBe("click")
    expect(mapActionName("select")).toBeUndefined()
  })
})

describe("linux observation building", () => {
  test("merges X11 windows and accessibility trees without inventing data", () => {
    const observation = buildObservation({
      windows: [windowFixture],
      applications: [appFixture],
      observationId: "obs-1",
    })
    expect(observation.id).toBe("obs-1")
    expect(observation.elements?.length).toBe(3)
    const button = observation.elements?.find((element) => element.id === "atspi:3.5")
    expect(button?.role).toBe("pushbutton")
    expect(button?.name).toBe("Export")
    expect(button?.actions).toEqual(["click"])
    expect(button?.reference).toMatchObject({ elementId: "atspi:3.5", observationId: "obs-1" })
    expect(button?.provenance).toMatchObject({ source: "application", trust: "untrusted" })
    expect(observation.capabilities?.accessibility).toBe("available")
    expect(observation.warnings).toEqual([])
  })

  test("tolerates null fields from the AT-SPI helper", () => {
    const observation = buildObservation({
      windows: [],
      applications: [
        {
          name: "portal",
          nodes: [
            {
              path: [0],
              role: "application",
              name: null,
              description: null,
              text: null,
              value: null,
              states: [],
              actions: [],
              bounds: null,
              children: [],
            },
          ],
        },
      ],
      observationId: "obs-null",
    })
    expect(observation.elements?.length).toBe(1)
    expect(observation.elements?.[0]?.name).toBeUndefined()
    expect(observation.elements?.[0]?.bounds).toBeUndefined()
  })

  test("reports honestly when no accessibility tree is exposed", () => {
    const observation = buildObservation({ windows: [windowFixture], applications: [], observationId: "obs-2" })
    expect(observation.capabilities?.accessibility).toBe("unavailable")
    expect(observation.warnings?.length).toBe(1)
    expect(observation.elements?.length).toBe(1)
  })

  test("summarizes compactly", () => {
    const observation = buildObservation({ windows: [windowFixture], applications: [appFixture], observationId: "obs-3" })
    const summary = summarizeObservation(observation, 2)
    expect(summary).toContain("observation obs-3: 3 elements")
    expect(summary).toContain("… 1 more")
  })

  test("window elements carry focus state", () => {
    const element = windowToElement(windowFixture, "obs-9")
    expect(element.id).toBe("x11:0x7400009")
    expect(element.states).toEqual(["focused"])
    expect(element.metadata).toMatchObject({ application: "Navigator", pid: 4242, active: true })
  })

  test("splits launch commands with arguments and quotes", () => {
    expect(splitCommand("dolphin")).toEqual(["dolphin"])
    expect(splitCommand("kate /tmp/notes.txt")).toEqual(["kate", "/tmp/notes.txt"])
    expect(splitCommand('kate "/tmp/my notes.txt" --new')).toEqual(["kate", "/tmp/my notes.txt", "--new"])
    expect(splitCommand("  ")).toEqual([])
  })
})
