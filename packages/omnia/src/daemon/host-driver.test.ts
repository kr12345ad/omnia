import { describe, expect, test } from "bun:test"
import { createHostDriver, INPUT_PERMISSION, withInputPermission } from "./host-driver"
import { LinuxHostDriver } from "./linux"
import type { Runner } from "./linux"
import type { CapabilitySupport } from "../protocol"

const observation = {
  id: "obs-1",
  source: "accessibility",
  backend: "linux-at-spi",
  elements: [
    {
      id: "atspi:0.1",
      role: "pushbutton",
      name: "Export",
      actions: ["click"],
      source: "accessibility",
      backend: "linux-at-spi",
      reference: { kind: "element", elementId: "atspi:0.1", observationId: "obs-1" },
      provenance: { source: "application", trust: "untrusted", authority: "none" },
      metadata: { application: "test", atspiPath: [0, 1], atspiActions: ["click"] },
    },
  ],
  provenance: { source: "system", trust: "trusted", authority: "system" },
}

function stubRunner(responses: Record<string, string>): Runner {
  return async (file, args) => {
    const key = `${file} ${args[0] ?? ""}`.trim()
    if (key in responses) return { stdout: responses[key]!, stderr: "" }
    throw new Error(`unexpected call: ${file} ${args.join(" ")}`)
  }
}

const SNAPSHOT = JSON.stringify({
  ok: true,
  applications: [
    {
      name: "test",
      error: null,
      nodes: [
        {
          path: [0],
          role: "frame",
          name: "Test",
          states: ["enabled"],
          actions: [],
          children: [
            {
              path: [0, 1],
              role: "pushbutton",
              name: "Export",
              states: ["enabled"],
              actions: ["click"],
              children: [],
            },
          ],
        },
      ],
    },
  ],
})

const WINDOWED_SNAPSHOT = JSON.stringify({
  ok: true,
  applications: [
    {
      name: "test",
      error: null,
      nodes: [
        {
          path: [0],
          role: "frame",
          name: "Test",
          states: ["enabled", "focused"],
          actions: [],
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          children: [
            {
              path: [0, 1],
              role: "pushbutton",
              name: "Export",
              states: ["enabled"],
              actions: [],
              bounds: { x: 100, y: 100, width: 40, height: 20 },
              children: [],
            },
          ],
        },
      ],
    },
  ],
})

function windowedRunner(): Runner {
  return async (file, args) => {
    if (file === "xprop" && args[0] === "-root" && args[1] === "_NET_CLIENT_LIST") {
      return { stdout: "_NET_CLIENT_LIST(WINDOW): window id # 0x1\n", stderr: "" }
    }
    if (file === "xprop" && args[0] === "-root" && args[1] === "_NET_ACTIVE_WINDOW") {
      return { stdout: "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x1\n", stderr: "" }
    }
    if (file === "xprop" && args[0] === "-id") {
      return { stdout: 'WM_CLASS(STRING) = "soffice", "libreoffice"\nWM_NAME(COMPOUND_TEXT) = "Writer"\n', stderr: "" }
    }
    if (file === "xwininfo") {
      return {
        stdout: "  Absolute upper-left X:  0\n  Absolute upper-left Y:  0\n  Width: 1920\n  Height: 1080\n",
        stderr: "",
      }
    }
    if (file === "xrandr") return { stdout: "eDP-1 connected primary 1920x1080+0+0 (normal) 344mm x 193mm\n", stderr: "" }
    if (file === "xdpyinfo") return { stdout: "  dimensions:    1920x1080 pixels (508x285 millimeters)\n", stderr: "" }
    if (file === "python3" && args[2] === "snapshot") return { stdout: WINDOWED_SNAPSHOT, stderr: "" }
    if (file === "python3" && args[2] === "pointer-window") {
      return { stdout: JSON.stringify({ ok: true, window: "0x2" }), stderr: "" }
    }
    return { stdout: JSON.stringify({ ok: true }), stderr: "" }
  }
}

describe("host driver", () => {
  test("revalidates targets against fresh observations", async () => {
    const host = new LinuxHostDriver({
      runner: stubRunner({ "xprop -root": "", "python3 -c": SNAPSHOT }),
      display: ":0",
    })
    const driver = createHostDriver(host)
    const valid = await driver.revalidateTarget({ kind: "element", elementId: "atspi:0.1" })
    expect(valid.valid).toBe(true)
    const missing = await driver.revalidateTarget({ kind: "element", elementId: "atspi:9.9" })
    expect(missing.valid).toBe(false)
    expect(missing.reason).toContain("atspi:9.9")
  })

  test("executes clicks through exposed actions and reports stale targets", async () => {
    const calls: string[] = []
    const host = new LinuxHostDriver({
      runner: (async (file, args) => {
        calls.push(`${file} ${args[0] ?? ""} ${args[2] ?? ""}`.trim())
        if (file === "xprop") return { stdout: "", stderr: "" }
        if (args[2] === "snapshot") return { stdout: SNAPSHOT, stderr: "" }
        return { stdout: JSON.stringify({ ok: true, result: true }), stderr: "" }
      }) as Runner,
      display: ":0",
    })
    const driver = createHostDriver(host)
    const result = await driver.execute({
      type: "click",
      target: { kind: "element", elementId: "atspi:0.1" },
    })
    expect(result.success).toBe(true)
    expect(calls.some((call) => call.includes(" act"))).toBe(true)

    const stale = await driver.execute({
      type: "click",
      target: { kind: "element", elementId: "atspi:9.9" },
    })
    expect(stale.success).toBe(false)
    expect(stale.error).toMatchObject({ code: "target_stale" })
  })

  test("falls back to global pointer input when an element exposes no action", async () => {
    const calls: string[] = []
    const snapshot = JSON.stringify({
      ok: true,
      applications: [
        {
          name: "test",
          error: null,
          nodes: [
            {
              path: [0],
              role: "pushbutton",
              name: "Export",
              states: ["enabled"],
              actions: [],
              bounds: { x: 100, y: 100, width: 40, height: 20 },
              children: [],
            },
          ],
        },
      ],
    })
    const host = new LinuxHostDriver({
      runner: (async (file, args) => {
        calls.push([file, ...args].join(" "))
        if (file === "xprop") return { stdout: "", stderr: "" }
        if (args[2] === "snapshot") return { stdout: snapshot, stderr: "" }
        return { stdout: JSON.stringify({ ok: true }), stderr: "" }
      }) as Runner,
      display: ":0",
    })
    const driver = createHostDriver(host)
    const result = await driver.execute({
      type: "click",
      target: { kind: "element", elementId: "atspi:0" },
    })
    expect(result.success).toBe(true)
    expect(calls.some((call) => call.includes("click --x 120 --y 110"))).toBe(true)
  })

  test("rejects element actions with no action and no bounds", async () => {
    const snapshot = JSON.stringify({
      ok: true,
      applications: [
        {
          name: "test",
          error: null,
          nodes: [{ path: [0], role: "pushbutton", name: "Export", states: ["enabled"], actions: [], children: [] }],
        },
      ],
    })
    const host = new LinuxHostDriver({
      runner: (async (file, args) => {
        if (file === "xprop") return { stdout: "", stderr: "" }
        if (args[2] === "snapshot") return { stdout: snapshot, stderr: "" }
        return { stdout: JSON.stringify({ ok: true }), stderr: "" }
      }) as Runner,
      display: ":0",
    })
    const driver = createHostDriver(host)
    const result = await driver.execute({
      type: "click",
      target: { kind: "element", elementId: "atspi:0" },
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatchObject({ code: "operation_unavailable" })
  })

  test("reports stale targets that vanished instead of executing", async () => {
    const host = new LinuxHostDriver({ runner: stubRunner({}), display: ":0" })
    const driver = createHostDriver(host)
    const result = await driver.execute({
      type: "click",
      target: { kind: "element", elementId: "x11:0x1" },
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatchObject({ code: "target_stale" })
  })

  test("marks input capabilities as approval-gated", () => {
    const capabilities: CapabilitySupport[] = [
      { capability: "keyboard", status: "degraded", score: 0.5 },
      { capability: "screen_read", status: "unknown", score: 0 },
    ]
    const gated = withInputPermission(capabilities)
    expect(gated[0]?.permissions).toEqual([INPUT_PERMISSION])
    expect(gated[1]?.permissions).toBeUndefined()
    expect(INPUT_PERMISSION.status).toBe("prompt")
  })

  test("matches application ids against accessibility names and window properties", async () => {
    const host = new LinuxHostDriver({ runner: windowedRunner(), display: ":0" })
    const byClass = await host.observe("LIBREOFFICE")
    expect(byClass.elements?.some((element) => element.id === "x11:0x1")).toBe(true)
    expect(byClass.elements?.some((element) => element.id === "atspi:0")).toBe(false)

    const byName = await host.observe("TEST")
    expect(byName.elements?.some((element) => element.id === "atspi:0.1")).toBe(true)

    const fallback = await host.observe("missing")
    expect(fallback.elements?.some((element) => element.id === "x11:0x1")).toBe(true)
    expect(
      fallback.warnings?.some((warning) => warning === 'No application matched "missing"; showing all windows and applications.'),
    ).toBe(true)
  })

  test("reports helper failures without leaking the command line", async () => {
    const host = new LinuxHostDriver({
      runner: (async () => {
        const error = new Error("Command failed: python3 -c SECRET_PAYLOAD") as Error & { code?: string }
        error.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
        throw error
      }) as Runner,
      display: ":0",
    })
    const failure = await host.executeKey("ctrl+s").catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    const message = failure instanceof Error ? failure.message : ""
    expect(message).toBe("AT-SPI key synthesis failed: helper process failed")
    expect(message).not.toContain("python3")
  })

  test("reports screen geometry in info metadata", async () => {
    const host = new LinuxHostDriver({ runner: windowedRunner(), display: ":0" })
    const info = await host.info()
    expect(info.metadata?.screen).toEqual({ width: 1920, height: 1080, widthMm: 508, heightMm: 285, scale: 1 })
    expect(host.capabilities().some((capability) => capability.capability === "screen_info")).toBe(true)
  })

  test("reports occlusion and focus mismatches without blocking input", async () => {
    const calls: string[] = []
    const runner = windowedRunner()
    const host = new LinuxHostDriver({
      runner: (async (file, args, timeoutMs, env) => {
        calls.push([file, ...args].join(" "))
        return runner(file, args, timeoutMs, env)
      }) as Runner,
      display: ":0",
    })
    const driver = createHostDriver(host)

    const clicked = await driver.execute({ type: "click", target: { kind: "element", elementId: "atspi:0.1" } })
    expect(clicked.success).toBe(true)
    expect(clicked.metadata?.occludedBy).toBe(
      "The click point is covered by window 0x2; bring the target window forward first.",
    )
    expect(calls.some((call) => call.includes("click --x 120 --y 110"))).toBe(true)

    const mismatched = await driver.execute({ type: "key", key: "ctrl+s", metadata: { windowId: "0x2" } })
    expect(String(mismatched.metadata?.focusWarning ?? "")).toContain("The active window is 0x1")

    const matched = await driver.execute({ type: "key", key: "ctrl+s", metadata: { windowId: "0x1" } })
    expect(matched.metadata?.focusWarning).toBeUndefined()

    expect(typeof driver.minimizeWindowId).toBe("function")
    expect(typeof driver.restoreWindowId).toBe("function")
    expect(await host.activeWindowId()).toBe("0x1")
    expect(await host.pointerWindow()).toEqual({ window: "0x2" })
  })

  test("observation fixture stays stable", () => {
    expect(observation.elements[0]?.id).toBe("atspi:0.1")
  })
})
