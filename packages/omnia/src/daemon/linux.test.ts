import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  allowCapability,
  buildObservation,
  commandRequiresShell,
  displayName,
  LinuxHostDriver,
  mapActionName,
  parseActiveWindowId,
  parseAtspiReference,
  parseWindowIds,
  parseXdpyinfo,
  parseXprop,
  parseXrandr,
  parseXrandrMonitors,
  parseXwininfo,
  probeDisplaySocket,
  refusedCapability,
  splitCommand,
  summarizeObservation,
  windowToElement,
  x11DisplayNumber,
} from "./linux"
import type { AtspiApplication, RunResult, Runner, X11Window } from "./linux"
import { createJsonLineHelper, parsePersistentHelperLine } from "./persistent-helper"
import type { PersistentHelper } from "./persistent-helper"
import { ATSPI_KEY_PY, ATSPI_SCRIPT, ATSPI_STATE_PY } from "./atspi-script"
import { LINUX_CUA_SCRIPT } from "../cua/backends/linux-script"
import { XTEST_SCRIPT } from "./xtest-script"

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

  test("parses the virtual screen from xrandr --listmonitors including negative origins", () => {
    const monitors = `Monitors: 2
 0: +*eDP-1 1920/344x1080/193+0+0  eDP-1
 1: +HDMI-1 1280/300x720/200-1280+0  HDMI-1
`
    expect(parseXrandrMonitors(monitors)).toEqual({ x: -1280, y: 0, width: 3200, height: 1080 })
    expect(parseXrandrMonitors("Monitors: 0")).toBeUndefined()
  })

  test("rejects geometry that parsed as zero instead of clicking at 0,0", () => {
    expect(parseXwininfo(GEOM)).toEqual({ x: 0, y: 28, width: 1920, height: 1022 })
    expect(parseXwininfo("  Width: 0\n  Height: 0\n")).toBeUndefined()
    expect(parseXwininfo("no geometry")).toBeUndefined()
  })

  test("derives display names with fallbacks", () => {
    expect(displayName(windowFixture)).toBe("Example page")
    expect(displayName({ id: "0x1", instance: "", cls: "xterm", title: "" })).toBe("xterm")
  })

  test("parses AT-SPI references and rejects garbage", () => {
    expect(parseAtspiReference("atspi:3.5.0")).toEqual([3, 5, 0])
    expect(parseAtspiReference("x11:0x1")).toBeUndefined()
    expect(parseAtspiReference("atspi:3.x")).toBeUndefined()
    expect(parseAtspiReference("atspi:")).toBeUndefined()
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
    expect(splitCommand("kate '' --new")).toEqual(["kate", "", "--new"])
    expect(splitCommand('kate "" --new')).toEqual(["kate", "", "--new"])
    expect(splitCommand("kate /tmp/a\\ b")).toEqual(["kate", "/tmp/a b"])
  })
})

function fakeAtspiHelper(
  applications: unknown,
  truncated = false,
  ready: Partial<{ ok: boolean; error: string }> = {},
): PersistentHelper {
  return {
    ready: Promise.resolve({ ok: ready.ok !== false, ...(ready.error === undefined ? {} : { error: ready.error }), payload: {} }),
    exited: false,
    async request(command) {
      if (command === "snapshot") {
        return { ok: true, payload: { applications, truncated } }
      }
      return { ok: false, error: `unsupported command: ${command}`, payload: {} }
    },
    async dispose() {},
  }
}

describe("linux observation metadata", () => {
  test("reports AT-SPI truncation as a warning instead of a complete tree", async () => {
    const calls: Array<{ file: string; args: string[] }> = []
    const runner: Runner = async (file, args): Promise<RunResult> => {
      calls.push({ file, args: [...args] })
      if (file === "which") return { stdout: `/usr/bin/${args[0]}\n`, stderr: "" }
      if (file === "xprop" && args[0] === "-root") return { stdout: "_NET_CLIENT_LIST(WINDOW): window id # 0x1\n", stderr: "" }
      return { stdout: "", stderr: "" }
    }
    const host = new LinuxHostDriver({
      runner,
      display: ":99",
      session: "x11",
      probeDisplay: false,
      atspiHelper: fakeAtspiHelper([
        {
          name: "firefox",
          nodes: [{ path: [0], role: "frame", name: "Example", states: [], actions: [], children: [] }],
        },
      ], true),
    })
    const observation = await host.observe()
    expect(observation.warnings?.some((warning) => warning.includes("truncated"))).toBe(true)
    expect(calls.some((call) => call.file === "xprop")).toBe(true)
  })

  test("cached observations carry a generation, hash, and cache age", async () => {
    const host = new LinuxHostDriver({
      runner: async (file) => (file === "xprop" ? { stdout: "", stderr: "" } : { stdout: "", stderr: "" }),
      display: ":0",
      probeDisplay: false,
      atspiHelper: fakeAtspiHelper([
        { name: "firefox", nodes: [{ path: [0], role: "frame", name: "Example", states: [], actions: [], children: [] }] },
      ]),
    })
    const first = await host.observe()
    const second = await host.observe()
    expect(first.id).toBe("obs-1")
    expect(first.metadata?.observationCached).toBe(false)
    expect(typeof first.metadata?.observationHash).toBe("string")
    expect(second.id).toBe("obs-1")
    expect(second.metadata?.observationCached).toBe(true)
    expect(second.metadata?.observationGeneration).toBe(first.metadata?.observationGeneration)
    expect(second.metadata?.observationHash).toBe(first.metadata?.observationHash)
    host.invalidateObservation()
    const third = await host.observe()
    expect(third.id).toBe("obs-2")
    expect(third.metadata?.observationGeneration).toBe(2)
    expect(third.metadata?.observationCached).toBe(false)
  })
})

describe("linux display probing", () => {
  test("parses local X11 display numbers and rejects remote hosts", () => {
    expect(x11DisplayNumber(":0")).toBe(0)
    expect(x11DisplayNumber(":0.0")).toBe(0)
    expect(x11DisplayNumber("unix:1")).toBe(1)
    expect(x11DisplayNumber("localhost:0")).toBeUndefined()
    expect(x11DisplayNumber("host:1.0")).toBeUndefined()
    expect(x11DisplayNumber("nonsense")).toBeUndefined()
  })

  test("probes a Wayland socket under the runtime directory", () => {
    const runtime = mkdtempSync(join(tmpdir(), "omnia-runtime-"))
    try {
      expect(probeDisplaySocket(undefined, "wayland-1", runtime)).toBe(false)
      writeFileSync(join(runtime, "wayland-1"), "")
      expect(probeDisplaySocket(undefined, "wayland-1", runtime)).toBe(true)
      expect(probeDisplaySocket(undefined, "/nonexistent/wayland-9", runtime)).toBe(false)
      expect(probeDisplaySocket(undefined, "wayland-1", undefined)).toBeUndefined()
      expect(probeDisplaySocket("localhost:0", undefined, runtime)).toBeUndefined()
    } finally {
      rmSync(runtime, { recursive: true, force: true })
    }
  })

  test("reports a stale DISPLAY as unavailable when the socket directory exists", () => {
    // Environments without a local X socket directory cannot be probed; only
    // assert the stale-display case when the probe is meaningful.
    const available = probeDisplaySocket(":0", undefined, undefined)
    if (available === undefined) return
    expect(available).toBe(true)
    expect(probeDisplaySocket(":98765", undefined, undefined)).toBe(false)
  })
})

describe("linux command boundary", () => {
  test("only routes commands with shell metacharacters through the shell", () => {
    expect(commandRequiresShell("printf omnia")).toBe(false)
    expect(commandRequiresShell("kate /tmp/notes.txt")).toBe(false)
    expect(commandRequiresShell("sh -c 'echo problem >&2; exit 3'")).toBe(true)
    expect(commandRequiresShell("ls | grep foo")).toBe(true)
    expect(commandRequiresShell("echo $HOME")).toBe(true)
    expect(commandRequiresShell("cat *.txt")).toBe(true)
  })

  test("runs plain commands argv-style with quoted arguments preserved", async () => {
    const host = new LinuxHostDriver()
    const result = await host.runCommand({ command: "printf '%s' 'a b'" })
    expect(result.success).toBe(true)
    expect(result.command?.stdout).toBe("a b")
  })

  test("keeps pipes and redirection working through the shell", async () => {
    const host = new LinuxHostDriver()
    const result = await host.runCommand({ command: "echo one; echo two" })
    expect(result.success).toBe(true)
    expect(result.command?.stdout).toBe("one\ntwo\n")
  })

  test("captures child stdin errors in CommandResult", async () => {
    const host = new LinuxHostDriver()
    const result = await host.runCommand({
      command: "sh -c 'exec 0<&-; sleep 0.5'",
      stdin: "z".repeat(1024 * 1024),
    })
    expect(result.success).toBe(true)
    expect(result.command?.stdinError).toContain("EPIPE")
  }, 10000)
})

describe("daemon persistent helper lifecycle", () => {
  test("reports a helper that never signals readiness without exiting", async () => {
    const helper = createJsonLineHelper({
      script: "while true; do sleep 1; done",
      label: "test helper",
      interpreter: "/bin/sh",
    })
    try {
      const settled = await Promise.race([
        helper.ready.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
      ])
      expect(settled).toBe(false)
      expect(helper.exited).toBe(false)
    } finally {
      await helper.dispose()
    }
    expect(helper.exited).toBe(true)
  })

  test("a spawned helper's exit rejects pending requests and requests after exit", async () => {
    const helper = createJsonLineHelper({ script: "exit 0", label: "test helper", interpreter: "/bin/sh" })
    const ready = await helper.ready
    expect(ready.ok).toBe(false)
    expect(helper.exited).toBe(true)
    await expect(helper.request("snapshot")).rejects.toThrow("not running")
  })

  test("dispose during an in-flight request rejects instead of hanging", async () => {
    const helper = createJsonLineHelper({
      script: "while true; do sleep 1; done",
      label: "test helper",
      interpreter: "/bin/sh",
    })
    const pending = helper.request("snapshot", {}, 5000)
    await helper.dispose()
    await expect(pending).rejects.toThrow("disposed")
    await expect(helper.request("snapshot")).rejects.toThrow("disposed")
    expect(helper.exited).toBe(true)
  })

  test("both AT-SPI scripts embed the shared state and key tables", () => {
    for (const script of [ATSPI_SCRIPT, LINUX_CUA_SCRIPT]) {
      expect(script).toContain(ATSPI_STATE_PY)
      expect(script).toContain(ATSPI_KEY_PY)
    }
  })

  test("the persistent AT-SPI script signals readiness without buffering", async () => {
    const interpreter = Bun.which("python3") ?? Bun.which("python")
    if (interpreter === null) return
    const helper = createJsonLineHelper({
      script: ATSPI_SCRIPT,
      label: "test atspi helper",
      interpreter,
      timeoutMs: 5000,
    })
    try {
      const ready = await Promise.race([
        helper.ready,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 3000)),
      ])
      if (ready === undefined) throw new Error("persistent AT-SPI helper never reported readiness")
      expect(ready.ok).toBe(true)
    } finally {
      await helper.dispose()
    }
  }, 10000)

  test("parses helper protocol lines and ignores malformed output", () => {
    expect(parsePersistentHelperLine('{"id":"1","ok":true}')).toMatchObject({ id: "1", ok: true })
    expect(parsePersistentHelperLine('{"ready":true,"ok":true}')).toMatchObject({ ready: true, ok: true })
    expect(parsePersistentHelperLine("junk")).toBeUndefined()
    expect(parsePersistentHelperLine("[]")).toBeUndefined()
  })
})

describe("linux shell commands", () => {
  test("captures exit code, stdout, and stderr", async () => {
    const host = new LinuxHostDriver()
    const result = await host.runCommand({ command: "printf omnia-shell" })
    expect(result.success).toBe(true)
    expect(result.command?.exitCode).toBe(0)
    expect(result.command?.stdout).toBe("omnia-shell")
    expect(result.command?.timedOut).toBe(false)
  })

  test("reports non-zero exits as failures", async () => {
    const host = new LinuxHostDriver()
    const result = await host.runCommand({ command: "sh -c 'echo problem >&2; exit 3'" })
    expect(result.success).toBe(false)
    expect(result.command?.exitCode).toBe(3)
    expect(result.command?.stderr).toContain("problem")
  })

  test("feeds stdin to the command", async () => {
    const host = new LinuxHostDriver()
    const result = await host.runCommand({ command: "cat", stdin: "secret\n" })
    expect(result.success).toBe(true)
    expect(result.command?.stdout).toBe("secret\n")
  })

  test("kills commands that exceed the timeout", async () => {
    const host = new LinuxHostDriver()
    const result = await host.runCommand({ command: "sleep 5", timeoutMs: 1000 })
    expect(result.success).toBe(false)
    expect(result.command?.timedOut).toBe(true)
  }, 10000)

  test("rejects a missing working directory", async () => {
    const host = new LinuxHostDriver()
    const result = await host.runCommand({ command: "true", cwd: "/definitely/not/a/directory" })
    expect(result.success).toBe(false)
    expect(typeof result.error === "object" ? result.error.code : undefined).toBe("invalid_cwd")
  })

  test("rejects environment overrides of PATH and DISPLAY", async () => {
    const host = new LinuxHostDriver()
    const result = await host.runCommand({ command: "true", env: { PATH: "/tmp/evil" } })
    expect(result.success).toBe(false)
    expect(typeof result.error === "object" ? result.error.code : undefined).toBe("invalid_env")
  })

  test("survives EPIPE when the command exits before reading stdin", async () => {
    const host = new LinuxHostDriver()
    const result = await host.runCommand({ command: "true", stdin: "z".repeat(1024 * 1024) })
    expect(result.success).toBe(true)
  }, 10000)
})

// The two paid primitives, gated on the surface the driver was built for. The
// assertions that matter are the ones about what did NOT happen: a refusal that
// arrives after the spawn or after the clipboard is touched is not enforcement.
describe("paid primitive enforcement", () => {
  test("refuses remote_shell on a free paired computer before anything is spawned", async () => {
    const probe = join(mkdtempSync(join(tmpdir(), "omnia-gate-")), "spawned")
    const host = new LinuxHostDriver({ access: { surface: "paired", plan: "free" } })
    const result = await host.runCommand({ command: `touch ${probe}` })
    expect(result.success).toBe(false)
    expect(result.status).toBe("rejected")
    expect(result.command).toBeUndefined()
    expect(result.error).toMatchObject({ code: "capability_not_entitled", retryable: false })
    expect(result.message).toContain("remote_shell")
    expect(result.message).toContain("free")
    // The dispatch is what would have created this file.
    expect(existsSync(probe)).toBe(false)
  })

  test("refuses a free paired computer before the clipboard is read", async () => {
    const calls: string[] = []
    const host = new LinuxHostDriver({
      access: { surface: "paired", plan: "free" },
      runner: async (file, args) => {
        calls.push(`${file} ${args.join(" ")}`)
        return { stdout: JSON.stringify({ ok: true, text: "secret", length: 6 }), stderr: "" }
      },
    })
    const result = await host.readClipboard()
    expect(result.success).toBe(false)
    expect(result.text).toBeUndefined()
    expect(result.error).toMatchObject({ code: "capability_not_entitled" })
    expect(result.message).toContain("clipboard")
    // Not even the python interpreter probe: the clipboard was never touched.
    expect(calls).toEqual([])
  })

  test("refuses a free paired computer before the clipboard is written", async () => {
    const calls: string[] = []
    const host = new LinuxHostDriver({
      access: { surface: "paired", plan: "free" },
      runner: async (file, args) => {
        calls.push(`${file} ${args.join(" ")}`)
        return { stdout: JSON.stringify({ ok: true }), stderr: "" }
      },
    })
    const written = await host.writeClipboard("secret")
    expect(written.success).toBe(false)
    expect(written.error).toMatchObject({ code: "capability_not_entitled" })
    const image = await host.writeClipboardImage("/tmp/whatever.png")
    expect(image.success).toBe(false)
    expect(image.error).toMatchObject({ code: "capability_not_entitled" })
    expect(calls).toEqual([])
  })

  test("refuses a paired computer whose plan nobody resolved", async () => {
    const host = new LinuxHostDriver({ access: { surface: "paired" } })
    const result = await host.runCommand({ command: "printf never" })
    expect(result.success).toBe(false)
    expect(result.message).toContain("free")
  })

  test("runs the command on a paid paired computer", async () => {
    const host = new LinuxHostDriver({ access: { surface: "paired", plan: "pro" } })
    const result = await host.runCommand({ command: "printf omnia-pro" })
    expect(result.success).toBe(true)
    expect(result.command?.stdout).toBe("omnia-pro")
  })

  test("leaves the local path alone: undeclared means local", async () => {
    const calls: string[] = []
    const host = new LinuxHostDriver({
      runner: async (file, args) => {
        calls.push(`${file} ${args.join(" ")}`)
        if (file === "which") return { stdout: "/usr/bin/python3", stderr: "" }
        return { stdout: JSON.stringify({ ok: true, text: "local-clip", length: 11 }), stderr: "" }
      },
    })
    const command = await host.runCommand({ command: "printf omnia-local" })
    expect(command.success).toBe(true)
    expect(command.command?.stdout).toBe("omnia-local")
    const read = await host.readClipboard()
    expect(read.success).toBe(true)
    expect(read.text).toBe("local-clip")
  })

  test("an explicitly local surface ignores a free plan", async () => {
    const host = new LinuxHostDriver({ access: { surface: "local", plan: "free" } })
    const result = await host.runCommand({ command: "printf omnia-local" })
    expect(result.success).toBe(true)
    expect(result.command?.stdout).toBe("omnia-local")
  })

  test("leaves every other primitive ungated", async () => {
    const calls: string[] = []
    const host = new LinuxHostDriver({
      access: { surface: "paired", plan: "free" },
      runner: async (file, args) => {
        calls.push(`${file} ${args.join(" ")}`)
        return { stdout: "", stderr: "" }
      },
    })
    // Only remote_shell and clipboard are gated. Input, observation, and the
    // rest of the driver must keep working on a free paired computer, and the
    // input-freeze lifecycle another owner depends on must not be reachable
    // from here at all.
    const info = await host.info()
    expect(info.id).toBe("linux-host")
    expect(calls.length).toBeGreaterThan(0)
    const denial = allowCapability({ surface: "paired", plan: "free" }, "input_freeze")
    expect(denial?.error).toMatchObject({ code: "capability_not_entitled" })
  })

  test("allowCapability names the capability and the plan it refused", () => {
    expect(allowCapability({ surface: "local", plan: "free" }, "remote_shell")).toBeUndefined()
    expect(allowCapability({ surface: "paired", plan: "pro" }, "remote_shell")).toBeUndefined()
    expect(allowCapability({ surface: "paired", plan: "pro" }, "clipboard")).toBeUndefined()
    const denial = allowCapability({ surface: "paired", plan: "free" }, "clipboard")
    expect(denial?.message).toContain("clipboard")
    expect(denial?.message).toContain("free")
    expect(denial?.error).toMatchObject({ code: "capability_not_entitled" })
    expect(refusedCapability("remote_shell", "free")).toMatchObject({
      success: false,
      status: "rejected",
      error: { code: "capability_not_entitled" },
    })
  })
})

const x11Display = process.env.DISPLAY
const describeX11Script = x11Display === undefined || x11Display.length === 0 ? describe.skip : describe

// Owns two scratch windows and nothing else: one normal mapped window, and one
// child of an unmapped parent that can never become viewable. It prints both
// ids and stays alive until the test kills it.
const XTEST_WINDOW_HOLDER_SCRIPT = `import ctypes
import sys
import time

x11 = ctypes.CDLL("libX11.so.6")
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XDefaultRootWindow.restype = ctypes.c_ulong
x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x11.XCreateSimpleWindow.restype = ctypes.c_ulong
x11.XCreateSimpleWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong, ctypes.c_ulong]
x11.XMapWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XFlush.argtypes = [ctypes.c_void_p]

display = x11.XOpenDisplay(None)
root = x11.XDefaultRootWindow(display)
visible = x11.XCreateSimpleWindow(display, root, 0, 0, 80, 60, 0, 0, 0)
x11.XMapWindow(display, visible)
hidden_parent = x11.XCreateSimpleWindow(display, root, 0, 0, 80, 60, 0, 0, 0)
hidden = x11.XCreateSimpleWindow(display, hidden_parent, 0, 0, 40, 30, 0, 0, 0)
x11.XMapWindow(display, hidden)
x11.XFlush(display)
sys.stdout.write(hex(visible) + " " + hex(hidden) + "\\n")
sys.stdout.flush()
time.sleep(30)
`

async function readFirstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  while (!buffer.includes("\n")) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
  }
  reader.releaseLock()
  return buffer.split("\n")[0] ?? ""
}

// The one-shot XTest helper must survive a window that is mid-transition. The
// pre-fix helper called XSetInputFocus on a non-viewable window, hit BadMatch,
// and Xlib's default error handler killed the process before any JSON line was
// emitted, which the action layer surfaced as "helper process failed".
describeX11Script("linux xtest window-state recovery", () => {
  const python = Bun.which("python3")

  async function runXTestScript(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const child = Bun.spawn([python!, "-c", XTEST_SCRIPT, ...args], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { code, stdout: stdout.trim(), stderr: stderr.trim() }
  }

  test("restore and activate survive an unmappable window", async () => {
    if (python === null) return
    const holder = Bun.spawn([python, "-c", XTEST_WINDOW_HOLDER_SCRIPT], { stdout: "pipe", stderr: "pipe" })
    try {
      const [visible, hidden] = (await readFirstLine(holder.stdout)).trim().split(/\s+/)
      if (visible === undefined || hidden === undefined) throw new Error("holder did not report window ids")

      // A mapped window restores and reports viewable.
      const mapped = await runXTestScript(["restore-window", "--window", visible])
      expect(mapped.code).toBe(0)
      expect(JSON.parse(mapped.stdout)).toMatchObject({ ok: true, viewable: true })
      expect(mapped.stderr).toBe("")

      // Minimize then restore back-to-back in the same second stays alive.
      const minimized = await runXTestScript(["minimize-window", "--window", visible])
      const restored = await runXTestScript(["restore-window", "--window", visible])
      expect(minimized.code).toBe(0)
      expect(restored.code).toBe(0)
      expect(JSON.parse(restored.stdout)).toMatchObject({ ok: true })

      // A window that never becomes viewable must not kill the helper; focus
      // is skipped and the command still answers with JSON.
      const unmappableRestore = await runXTestScript(["restore-window", "--window", hidden])
      expect(unmappableRestore.code).toBe(0)
      expect(JSON.parse(unmappableRestore.stdout)).toMatchObject({ ok: true, viewable: false })
      const unmappableActivate = await runXTestScript(["activate", "--window", hidden])
      expect(unmappableActivate.code).toBe(0)
      expect(JSON.parse(unmappableActivate.stdout)).toMatchObject({ ok: true })
    } finally {
      holder.kill()
      await holder.exited.catch(() => undefined)
    }
  }, 20000)
})

describe("linux screen capture path", () => {
  // The capture tools run outside this process, so the test stands in for them
  // and only records what the driver handed them.
  test("captures into a private temp directory that is removed afterwards", async () => {
    const handed: Array<{ file: string; directory: string; directoryMode: number; fileMode: number }> = []
    const driver = new LinuxHostDriver({
      display: ":99",
      session: "x11",
      probeDisplay: false,
      runner: async (_file, args) => {
        const file = args[args.length - 1] ?? ""
        const directory = dirname(file)
        handed.push({
          file,
          directory,
          directoryMode: statSync(directory).mode & 0o777,
          fileMode: statSync(file).mode & 0o777,
        })
        writeFileSync(file, "fake-png-bytes")
        return { stdout: "", stderr: "" }
      },
    })

    const result = await driver.captureScreen()

    expect(result.success).toBe(true)
    expect(result.path).toBe(handed[0]?.file)
    // Not a predictable name straight in the world-writable tmp root, and both
    // the directory and the image are owner-only while the capture runs.
    expect(handed[0]?.directory).not.toBe(tmpdir())
    expect(handed[0]?.directory.startsWith(tmpdir())).toBe(true)
    expect(handed[0]?.directoryMode).toBe(0o700)
    expect(handed[0]?.fileMode).toBe(0o600)
    expect(existsSync(dirname(result.path ?? ""))).toBe(false)
  })
})
