import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventBus } from "./events"
import { OMNIA_ACTION_CATALOG } from "./catalog"
import { PermissionManager, requiredScopesForAction, type ApprovalPolicy, type OmniaScope, type PermissionState } from "./permissions"
import { ComputerManager, type ServerComputerDriver } from "./computers"
import { CalibrationManager } from "../computer-use/calibration"
import { isComputerAction } from "../protocol"
import type { ActionResult, CapabilitySupport, ComputerAction, Observation } from "../protocol"

function errorCode(error: ActionResult["error"]): string | undefined {
  return typeof error === "object" && error !== null ? error.code : error
}

function baseDriver(overrides: Partial<ServerComputerDriver> = {}): ServerComputerDriver {
  const driver: ServerComputerDriver = {
    id: "local",
    backend: "test",
    getInfo: async () => ({ id: "local", name: "Test Computer", platform: "linux", connected: true }),
    capabilities: () => [],
    observe: async (): Promise<Observation> => ({ id: "obs-1", elements: [] }),
    find: async (request) => ({ query: request.query, matches: [] }),
    execute: async (action: ComputerAction): Promise<ActionResult> => ({
      success: true,
      status: "success",
      message: `Executed ${action.type}.`,
    }),
  }
  return Object.assign(driver, overrides)
}

function createManager(
  driver: ServerComputerDriver,
  options: {
    permissions?: Partial<Record<OmniaScope, PermissionState>>
    policy?: ApprovalPolicy
    calibration?: CalibrationManager
  } = {},
): { manager: ComputerManager; events: EventBus } {
  const events = new EventBus({ serverId: "test" })
  const permissions = new PermissionManager(options.permissions ?? {}, options.policy ?? "fully_autonomous")
  const manager = new ComputerManager({
    events,
    permissions,
    ...(options.calibration === undefined ? {} : { calibration: options.calibration }),
  })
  manager.register(driver)
  return { manager, events }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("incomplete observations never verify", () => {
  test("a truncated follow-up observation cannot mark an action verified", async () => {
    const driver = baseDriver({
      observe: async () => ({ id: "obs-1", elements: [] }),
      execute: async () => ({
        success: true,
        status: "success",
        message: "clicked",
        observation: {
          id: "obs-2",
          elements: [{ id: "new-el", role: "button", name: "New" }],
          metadata: { truncated: true },
        },
      }),
    })
    const { manager } = createManager(driver)
    const outcome = await manager.execute("local", { action: "click", x: 10, y: 10 })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.verification?.status).toBe("unverified")
    expect(outcome.result.verification?.message).toContain("incomplete")
  })

  test("complete observations still verify the same delta", async () => {
    const driver = baseDriver({
      observe: async () => ({ id: "obs-1", elements: [] }),
      execute: async () => ({
        success: true,
        status: "success",
        message: "clicked",
        observation: {
          id: "obs-2",
          elements: [{ id: "new-el", role: "button", name: "New" }],
          metadata: { truncated: false },
        },
      }),
    })
    const { manager } = createManager(driver)
    const outcome = await manager.execute("local", { action: "click", x: 10, y: 10 })
    expect(outcome.result.verification?.status).toBe("verified")
  })
})

describe("truncated observations verify from action-local evidence", () => {
  test("a targeted change observed in both truncated observations verifies", async () => {
    const driver = baseDriver({
      observe: async () => ({
        id: "obs-1",
        elements: [{ id: "el-1", role: "textbox", name: "Field", value: "before", states: [] }],
        metadata: { truncated: true },
      }),
      execute: async () => ({
        success: true,
        status: "success",
        message: "set",
        observation: {
          id: "obs-2",
          elements: [{ id: "el-1", role: "textbox", name: "Field", value: "after", states: [] }],
          metadata: { truncated: true },
        },
      }),
    })
    const { manager } = createManager(driver)
    await manager.observe("local")
    const outcome = await manager.execute("local", { action: "set_value", target: { elementId: "el-1" }, text: "after" })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.verification?.status).toBe("verified")
    expect(outcome.result.verification?.message).toContain("target")
  })

  test("a new window in a truncated observation verifies open_file", async () => {
    const driver = baseDriver({
      observe: async () => ({
        id: "obs-1",
        elements: [{ id: "win-1", role: "window", name: "Desktop", states: ["focused"] }],
        metadata: { truncated: true },
      }),
      execute: async () => ({
        success: true,
        status: "success",
        message: "opened",
        observation: {
          id: "obs-2",
          elements: [
            { id: "win-1", role: "window", name: "Desktop", states: [] },
            { id: "win-2", role: "window", name: "Vendor_Master.ods", states: ["focused"] },
          ],
          metadata: { truncated: true },
        },
      }),
    })
    const { manager } = createManager(driver)
    await manager.observe("local")
    const outcome = await manager.execute("local", { action: "open_file", path: "/tmp/Vendor_Master.ods", approve: true, approvedScopes: ["PROCESS_EXECUTE"] })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.verification?.status).toBe("verified")
  })

  test("move verifies from the driver's pointer readback", async () => {
    const driver = baseDriver({
      observe: async () => ({ id: "obs-1", elements: [], metadata: { truncated: true } }),
      execute: async () => ({
        success: true,
        status: "success",
        message: "moved",
        metadata: { x: 640, y: 400, durationMs: 240 },
      }),
    })
    const { manager } = createManager(driver)
    await manager.observe("local")
    const outcome = await manager.execute("local", { action: "move", x: 640, y: 400 })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.verification?.status).toBe("verified")
    expect(outcome.result.verification?.method).toBe("driver-readback")
  })

  test("move verifies from the driver acknowledgement without readback metadata", async () => {
    const driver = baseDriver({
      observe: async () => ({ id: "obs-1", elements: [], metadata: { truncated: true } }),
      execute: async () => ({ success: true, status: "success", message: "moved" }),
    })
    const { manager } = createManager(driver)
    await manager.observe("local")
    const outcome = await manager.execute("local", { action: "move", x: 10, y: 20 })
    expect(outcome.result.verification?.status).toBe("verified")
    expect(outcome.result.verification?.message).toContain("confirmed the pointer move")
  })

  test("driver-provided verification is preferred over the truncated diff", async () => {
    const driver = baseDriver({
      observe: async () => ({ id: "obs-1", elements: [], metadata: { truncated: true } }),
      execute: async () => ({
        success: true,
        status: "success",
        message: "invoked",
        verification: { status: "verified", method: "cua-snapshot", message: "The engine confirmed the invoke." },
      }),
    })
    const { manager } = createManager(driver)
    await manager.observe("local")
    const outcome = await manager.execute("local", { action: "click", target: { elementId: "el-1" } })
    expect(outcome.result.verification?.status).toBe("verified")
    expect(outcome.result.verification?.method).toBe("cua-snapshot")
  })

  test("a target missing from the truncated observation stays unverified", async () => {
    const driver = baseDriver({
      observe: async () => ({
        id: "obs-1",
        elements: [{ id: "el-1", role: "textbox", name: "Field", value: "before", states: [] }],
        metadata: { truncated: true },
      }),
      execute: async () => ({
        success: true,
        status: "success",
        message: "set",
        observation: {
          id: "obs-2",
          elements: [{ id: "el-2", role: "button", name: "Elsewhere", states: [] }],
          metadata: { truncated: true },
        },
      }),
    })
    const { manager } = createManager(driver)
    await manager.observe("local")
    const outcome = await manager.execute("local", { action: "set_value", target: { elementId: "el-1" }, text: "after" })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.verification?.status).toBe("unverified")
    expect(outcome.result.verification?.message).toContain("missing")
  })
})

describe("dismiss action mapping", () => {
  test("dismiss maps to the protocol dismiss action and needs UI_CONTROL", async () => {
    const actions: ComputerAction[] = []
    const driver = baseDriver({
      execute: async (action): Promise<ActionResult> => {
        actions.push(action)
        return { success: true, status: "success", message: "dismissed" }
      },
    })
    const { manager } = createManager(driver)
    const outcome = await manager.execute("local", { action: "dismiss" })
    expect(outcome.result.success).toBe(true)
    expect(actions).toEqual([{ type: "dismiss" }])
    expect(requiredScopesForAction("dismiss")).toEqual(["UI_CONTROL"])
  })
})

describe("canonical action scope map", () => {
  test("window_close, paste_table, and scroll_into_view carry their exact scopes", () => {
    expect(requiredScopesForAction("window_close")).toEqual(["PROCESS_EXECUTE"])
    expect(requiredScopesForAction("paste_table")).toEqual(["CLIPBOARD_WRITE", "KEYBOARD", "POINTER"])
    expect(requiredScopesForAction("scroll_into_view")).toEqual(["POINTER"])
    // The catalog is derived from the canonical map and must not drift from it.
    expect(OMNIA_ACTION_CATALOG.find((entry) => entry.action === "window_close")?.requires).toEqual(["PROCESS_EXECUTE"])
    expect(OMNIA_ACTION_CATALOG.find((entry) => entry.action === "paste_table")?.requires).toEqual([
      "CLIPBOARD_WRITE",
      "KEYBOARD",
      "POINTER",
    ])
    expect(OMNIA_ACTION_CATALOG.find((entry) => entry.action === "scroll_into_view")?.requires).toEqual(["POINTER"])
  })
})

describe("batch calibration steps", () => {
  test("calibration_start, calibration_measure, and calibration_status run inside a plan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-cal-batch-"))
    const calibration = new CalibrationManager({ file: join(dir, "calibration.json") })
    const driver = baseDriver({
      getInfo: async () => ({
        id: "local",
        name: "Test Computer",
        platform: "linux",
        connected: true,
        screen: { width: 1000, height: 800 },
      }),
      pointerPosition: async () => ({ success: true, status: "success", message: "read", x: 500, y: 400 }),
    })
    const { manager } = createManager(driver, { calibration })
    const outcome = await manager.executeBatch("local", {
      steps: [
        { action: "calibration_start" },
        { action: "calibration_measure", text: "p11" },
        { action: "calibration_status" },
      ],
    })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.steps.map((step) => step.action)).toEqual([
      "calibration_start",
      "calibration_measure",
      "calibration_status",
    ])
    expect(outcome.result.steps[1]?.success).toBe(true)
    expect(outcome.result.steps[1]?.message).toContain("p11")
    expect(outcome.result.steps[2]?.success).toBe(true)
  })
})

describe("plan expect.text reads the step output", () => {
  const pointerDriver = () =>
    baseDriver({
      pointerPosition: async () => ({
        success: true,
        status: "success",
        message: "The pointer is at 500,600.",
        x: 500,
        y: 600,
        held: false,
      }),
    })

  test("the pointer message satisfies the expectation", async () => {
    const { manager } = createManager(pointerDriver())
    const outcome = await manager.executeBatch("local", {
      steps: [{ action: "get_cursor", expect: { text: "The pointer" } }],
    })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.steps[0]?.success).toBe(true)
    expect(outcome.result.steps[0]?.error).toBeUndefined()
  })

  test("coordinates from the pointer message satisfy the expectation", async () => {
    const { manager } = createManager(pointerDriver())
    const outcome = await manager.executeBatch("local", {
      steps: [{ action: "get_cursor", expect: { text: "500,600" } }],
    })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.steps[0]?.success).toBe(true)
  })

  test("a read_clipboard payload satisfies the expectation", async () => {
    const driver = baseDriver({
      readClipboard: async () => ({
        success: true,
        status: "success",
        message: "Clipboard read.",
        text: "hello from the clipboard",
        length: 23,
      }),
    })
    const { manager } = createManager(driver)
    const outcome = await manager.executeBatch("local", {
      steps: [{ action: "read_clipboard", expect: { text: "from the clipboard" } }],
    })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.steps[0]?.success).toBe(true)
  })

  test("a driver verification message satisfies the expectation", async () => {
    const driver = baseDriver({
      execute: async () => ({
        success: true,
        status: "success",
        message: "clicked",
        // Independent readback methods are trusted driver evidence; a generic
        // method:"driver" claim would be ignored fail-closed (see
        // isIndependentDriverVerification) and could not satisfy the expect.
        verification: { status: "verified", message: "The pane now shows quantum-widget.", method: "cua-snapshot" },
      }),
    })
    const { manager } = createManager(driver)
    const outcome = await manager.executeBatch("local", {
      steps: [{ action: "click", x: 5, y: 5, expect: { text: "quantum-widget" } }],
    })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.steps[0]?.success).toBe(true)
  })

  test("a state-delta summary satisfies the expectation", async () => {
    const driver = baseDriver({
      execute: async () => ({
        success: true,
        status: "success",
        message: "clicked",
        observation: { id: "obs-2", elements: [{ id: "el-2", role: "status", name: "quantum-widget" }] },
      }),
    })
    const { manager } = createManager(driver)
    const outcome = await manager.executeBatch("local", {
      steps: [{ action: "click", x: 5, y: 5, expect: { text: "quantum-widget" } }],
    })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.steps[0]?.success).toBe(true)
  })

  test("text absent from the interface and the output stays unmet", async () => {
    const { manager } = createManager(pointerDriver())
    const outcome = await manager.executeBatch("local", {
      steps: [{ action: "get_cursor", expect: { text: "The pointer is at 10,20" } }],
    })
    expect(outcome.result.success).toBe(false)
    expect(outcome.result.steps[0]?.success).toBe(false)
    expect(errorCode(outcome.result.steps[0]?.error)).toBe("expectation_unmet")
    expect(outcome.result.steps[0]?.message).toContain("interface or the step output")
  })
})

describe("read_text window matching", () => {
  const readingDriver = (
    elements: Observation["elements"],
    inputs: Array<{ elementId?: string; application?: string }>,
  ) =>
    baseDriver({
      observe: async () => ({ id: "obs-1", elements }),
      readText: async (input) => {
        inputs.push(input)
        return { success: true, status: "success", message: "read", text: "content" }
      },
    })

  test("window aliases and ranked names resolve the same as focus/app matching", async () => {
    const inputs: Array<{ elementId?: string; application?: string }> = []
    const driver = readingDriver(
      [
        { id: "w1", role: "window", name: "LibreOffice Calc", metadata: { application: "soffice" } },
        { id: "w2", role: "window", name: "Files", metadata: { application: "dolphin" } },
      ],
      inputs,
    )
    const { manager } = createManager(driver)
    const alias = await manager.execute("local", { action: "read_text", window: "libreoffice" })
    expect(alias.httpStatus).toBe(200)
    expect(inputs[0]?.elementId).toBe("w1")

    const files = await manager.execute("local", { action: "read_text", window: "files" })
    expect(files.httpStatus).toBe(200)
    expect(inputs[1]?.elementId).toBe("w2")

    const exact = await manager.execute("local", { action: "read_text", window: "Files" })
    expect(exact.httpStatus).toBe(200)
    expect(inputs[2]?.elementId).toBe("w2")

    const missing = await manager.execute("local", { action: "read_text", window: "no such window" })
    expect(missing.httpStatus).toBe(400)
  })

  test("a window matched by title is read by element id, not by application", async () => {
    const inputs: Array<{ elementId?: string; application?: string }> = []
    const driver = readingDriver(
      [
        {
          id: "cua:window/libreoffice-calc/vendor-master-ods/0",
          role: "window",
          name: "Vendor_Master.ods - LibreOffice Calc",
          metadata: { application: "libreoffice-calc" },
        },
      ],
      inputs,
    )
    const { manager } = createManager(driver)
    const outcome = await manager.execute("local", { action: "read_text", window: "Vendor_Master.ods" })
    expect(outcome.httpStatus).toBe(200)
    expect(outcome.result.success).toBe(true)
    expect((outcome.result as ActionResult & { text?: string }).text).toBe("content")
    expect(inputs[0]?.elementId).toBe("cua:window/libreoffice-calc/vendor-master-ods/0")
    // The WM class must never leak into the AT-SPI application input.
    expect(inputs[0]?.application).toBeUndefined()
  })

  test("an id-less window resolves the AT-SPI app for the same title", async () => {
    const inputs: Array<{ elementId?: string; application?: string }> = []
    const driver = readingDriver(
      [
        {
          role: "window",
          name: "Vendor_Master.ods - LibreOffice Calc",
          source: "native",
          metadata: { application: "libreoffice-calc" },
        },
        {
          id: "atspi:1.2",
          role: "window",
          name: "Vendor_Master.ods - LibreOffice Calc",
          source: "accessibility",
          metadata: { application: "org.libreoffice.LibreOffice", atspiPath: [0, 3] },
        },
      ],
      inputs,
    )
    const { manager } = createManager(driver)
    const outcome = await manager.execute("local", { action: "read_text", window: "Vendor_Master.ods" })
    expect(outcome.httpStatus).toBe(200)
    expect(inputs[0]?.application).toBe("org.libreoffice.LibreOffice")
    expect(inputs[0]?.elementId).toBeUndefined()
  })

  test("an id-less WM-class-only window is rejected clearly instead of passing the class through", async () => {
    const inputs: Array<{ elementId?: string; application?: string }> = []
    const driver = readingDriver(
      [{ role: "window", name: "Vendor_Master.ods - LibreOffice Calc", source: "native", metadata: { application: "libreoffice-calc" } }],
      inputs,
    )
    const { manager } = createManager(driver)
    const outcome = await manager.execute("local", { action: "read_text", window: "Vendor_Master.ods" })
    expect(outcome.httpStatus).toBe(400)
    expect(outcome.result.success).toBe(false)
    expect(errorCode(outcome.result.error)).toBe("invalid_action")
    expect(outcome.result.message).toContain("AT-SPI")
    expect(inputs).toHaveLength(0)
  })

  test("no matching window answers a clear 4xx, never a generic 500", async () => {
    const inputs: Array<{ elementId?: string; application?: string }> = []
    const driver = readingDriver([{ id: "w1", role: "window", name: "Files" }], inputs)
    const { manager } = createManager(driver)
    const outcome = await manager.execute("local", { action: "read_text", window: "Vendor_Master.ods" })
    expect(outcome.httpStatus).toBe(400)
    expect(outcome.httpStatus).not.toBe(500)
    expect(outcome.result.message).toContain("No open window matches")
    expect(inputs).toHaveLength(0)
  })

  test("a throwing runtime is reported as read_failed, not a generic 500", async () => {
    const driver = baseDriver({
      observe: async () => ({ id: "obs-1", elements: [{ id: "w1", role: "window", name: "Files" }] }),
      readText: async () => {
        throw new Error("daemon exploded")
      },
    })
    const { manager } = createManager(driver)
    const outcome = await manager.execute("local", { action: "read_text", window: "Files" })
    expect(outcome.httpStatus).toBe(502)
    expect(errorCode(outcome.result.error)).toBe("read_failed")
  })
})

describe("focus verification is positive, not focus-loss", () => {
  const windowElement = (id: string, name: string, focused: boolean): NonNullable<Observation["elements"]>[number] => ({
    id,
    role: "window",
    name,
    states: focused ? ["focused"] : [],
  })

  test("a target that is already focused verifies", async () => {
    const driver = baseDriver({
      observe: async () => ({ id: "obs-1", elements: [windowElement("w1", "Editor", true), windowElement("w2", "Other", false)] }),
      execute: async () => ({ success: true, status: "success", message: "focused" }),
    })
    const { manager } = createManager(driver)
    const outcome = await manager.execute("local", { action: "focus", target: { elementId: "w1" } })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.verification?.status).toBe("verified")
  })

  test("focus moving to the target verifies", async () => {
    let focused = "w2"
    const driver = baseDriver({
      observe: async () => ({
        id: "obs-1",
        elements: [windowElement("w1", "Editor", focused === "w1"), windowElement("w2", "Other", focused === "w2")],
      }),
      execute: async () => {
        focused = "w1"
        return { success: true, status: "success", message: "focused" }
      },
    })
    const { manager } = createManager(driver)
    const outcome = await manager.execute("local", { action: "focus", target: { elementId: "w1" } })
    expect(outcome.result.verification?.status).toBe("verified")
  })

  test("a target that is not focused stays unverified and names the active window", async () => {
    const driver = baseDriver({
      observe: async () => ({ id: "obs-1", elements: [windowElement("w1", "Editor", false), windowElement("w2", "Other", true)] }),
      execute: async () => ({ success: true, status: "success", message: "focused" }),
    })
    const { manager } = createManager(driver)
    const outcome = await manager.execute("local", { action: "focus", target: { elementId: "w1" } })
    expect(outcome.result.verification?.status).toBe("unverified")
    expect(outcome.result.verification?.message).toContain("not focused")
    expect(outcome.result.verification?.message).toContain("Other")
  })

  test("focus on a window matched by title verifies through the observation", async () => {
    const driver = baseDriver({
      observe: async () => ({
        id: "obs-1",
        elements: [windowElement("w1", "Vendor_Master.ods - LibreOffice Calc", true)],
      }),
      execute: async () => ({ success: true, status: "success", message: "focused" }),
    })
    const { manager } = createManager(driver)
    const outcome = await manager.execute("local", { action: "focus_window", window: "Vendor_Master.ods" })
    expect(outcome.httpStatus).toBe(200)
    expect(outcome.result.verification?.status).toBe("verified")
  })

})

describe("input driver selection and freeze confirmation", () => {
  test("freeze/release/state need an explicit computer id", async () => {
    let grabCalls = 0
    const driver = baseDriver({
      grabInput: async () => {
        grabCalls += 1
        return { success: true, status: "success", message: "grabbed" }
      },
    })
    const { manager } = createManager(driver)
    const freeze = await manager.freezeInput(undefined)
    expect(freeze.frozen).toBe(false)
    expect(freeze.supported).toBe(false)
    expect(freeze.error).toContain("explicit computer")
    expect(grabCalls).toBe(0)
    const release = await manager.releaseInput(undefined)
    expect(release.error).toContain("explicit computer")
    const state = await manager.inputState()
    expect(state.supported).toBe(false)
    expect(state.reason).toContain("explicit computer")
  })

  test("freezeInput requires frozen === true", async () => {
    const driver = baseDriver({
      grabInput: async () => ({ success: true, status: "success", message: "grabbed" }),
    })
    const { manager } = createManager(driver)
    const outcome = await manager.freezeInput("local")
    expect(outcome.frozen).toBe(false)
    expect(outcome.supported).toBe(true)
    expect(outcome.error).toContain("did not confirm")
  })

  test("freezeInput accepts an explicit frozen:true", async () => {
    const driver = baseDriver({
      grabInput: async () => ({ success: true, status: "success", message: "grabbed", frozen: true }),
    })
    const { manager } = createManager(driver)
    const outcome = await manager.freezeInput("local")
    expect(outcome).toEqual({ frozen: true, supported: true, mode: "x11" })
  })
})

describe("driver registration validation", () => {
  test("empty ids and duplicate registrations are rejected", () => {
    const { manager } = createManager(baseDriver())
    const remove = manager.register(baseDriver({ id: "extra" }))
    expect(() => manager.register(baseDriver({ id: "extra" }))).toThrow(/already registered/)
    expect(() => manager.register(baseDriver({ id: "   " }))).toThrow(/id is required/)
    remove()
    const reRegister = manager.register(baseDriver({ id: "extra" }))
    reRegister()
  })
})

describe("cancellation between and during driver calls", () => {
  test("stop cancels an in-flight driver call without waiting for it", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const driver = baseDriver({
      execute: async (action) => {
        if (action.type === "click") await gate
        return { success: true, status: "success", message: `Executed ${action.type}.` }
      },
    })
    const { manager } = createManager(driver)
    const pending = manager.execute("local", { action: "click", target: { elementId: "el-1" } })
    await delay(30)
    await manager.stop("local", { reason: "test stop" })
    const outcome = await Promise.race([
      pending,
      delay(1000).then(() => {
        throw new Error("the in-flight action was not cancelled")
      }),
    ])
    expect(outcome.httpStatus).toBe(409)
    expect(errorCode(outcome.result.error)).toBe("action_cancelled")
    release()
  })

  test("paste_table stops between clipboard write and key dispatch", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const executed: string[] = []
    const driver = baseDriver({
      writeClipboard: async () => {
        await gate
        return { success: true, status: "success", message: "wrote" }
      },
      execute: async (action) => {
        executed.push(action.type)
        return { success: true, status: "success", message: `Executed ${action.type}.` }
      },
    })
    const { manager } = createManager(driver)
    const pending = manager.execute("local", { action: "paste_table", text: "a\tb" })
    await delay(30)
    await manager.stop("local", { reason: "test stop" })
    release()
    const outcome = await pending
    expect(outcome.httpStatus).toBe(409)
    expect(executed).toEqual([])
  })

  test("executeMenu stops between the item find and its click", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const executed: string[] = []
    const driver = baseDriver({
      find: async (request) => {
        await gate
        return { query: request.query, matches: [{ element: { id: "m1", role: "menuitem", name: request.query }, score: 1 }] }
      },
      execute: async (action) => {
        executed.push(action.type)
        return { success: true, status: "success", message: `Executed ${action.type}.` }
      },
    })
    const { manager } = createManager(driver)
    const pending = manager.execute("local", { action: "menu", query: "File > Open" })
    await delay(30)
    await manager.stop("local", { reason: "test stop" })
    release()
    const outcome = await pending
    expect(outcome.httpStatus).toBe(409)
    expect(executed).toEqual([])
  })
})

describe("run_command failures", () => {
  const command = (exitCode: number, timedOut = false) =>
    baseDriver({
      runCommand: async () => ({
        success: true,
        status: "success",
        message: "command finished",
        command: { exitCode, stdout: "", stderr: "boom", truncated: false, timedOut, durationMs: 5 },
      }),
    })

  test("a non-zero exit answers 409 with an error object", async () => {
    const { manager } = createManager(command(2))
    const outcome = await manager.execute("local", { action: "run_command", command: "false", sessionId: "s", approve: true, approvedScopes: ["PROCESS_EXECUTE"] })
    expect(outcome.httpStatus).toBe(409)
    expect(outcome.result.success).toBe(false)
    expect(errorCode(outcome.result.error)).toBe("command_failed")
    expect(outcome.result.verification?.status).toBe("failed")
    expect((outcome.result.metadata as { exitCode?: number }).exitCode).toBe(2)
  })

  test("a timed-out command answers 504 with a timeout code", async () => {
    const { manager } = createManager(command(undefined as unknown as number, true))
    const outcome = await manager.execute("local", { action: "run_command", command: "sleep 100", sessionId: "s", approve: true, approvedScopes: ["PROCESS_EXECUTE"] })
    expect(outcome.httpStatus).toBe(504)
    expect(errorCode(outcome.result.error)).toBe("command_timeout")
  })
})

describe("window verification shell gate", () => {
  const windowObservation: Observation = {
    id: "obs-1",
    elements: [{ id: "0x1", role: "window", name: "Editor", states: ["focused"] }],
  }
  function shellDriver() {
    const commands: string[] = []
    const driver = baseDriver({
      observe: async () => windowObservation,
      execute: async () => ({ success: true, status: "success", message: "minimized" }),
      runCommand: async (request) => {
        commands.push(request.command)
        const stdout = request.command.includes("activeWindow") ? "0x1" : "minimized: true"
        return {
          success: true,
          status: "success",
          message: "ran",
          command: { exitCode: 0, stdout, stderr: "", truncated: false, timedOut: false, durationMs: 1 },
        }
      },
    })
    return { driver, commands }
  }

  test("agent sessions without PROCESS_EXECUTE verify focus from the observation without shelling out", async () => {
    const { driver, commands } = shellDriver()
    const { manager } = createManager(driver, {
      permissions: { UI_CONTROL: "granted" },
      policy: "ask_destructive",
    })
    const outcome = await manager.execute("local", { action: "focus", target: { elementId: "0x1" }, sessionId: "s" })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.verification?.status).toBe("verified")
    expect(commands).toHaveLength(0)
  })

  test("agent sessions with PROCESS_EXECUTE approval use the KWin shell path", async () => {
    const { driver, commands } = shellDriver()
    const { manager } = createManager(driver, {
      permissions: { UI_CONTROL: "granted", PROCESS_EXECUTE: "granted" },
      policy: "ask_destructive",
    })
    const outcome = await manager.execute("local", {
      action: "focus",
      target: { elementId: "0x1" },
      sessionId: "s",
      approve: true,
      approvedScopes: ["PROCESS_EXECUTE"],
    })
    expect(outcome.result.success).toBe(true)
    expect(commands.length).toBeGreaterThan(0)
    expect(commands[0]).toContain("qdbus")
  })

  test("desktop calls keep the shell path without the gate", async () => {
    const { driver, commands } = shellDriver()
    const { manager } = createManager(driver, {
      permissions: { UI_CONTROL: "granted" },
      policy: "ask_destructive",
    })
    const outcome = await manager.execute("local", { action: "focus", target: { elementId: "0x1" } })
    expect(outcome.result.success).toBe(true)
    expect(commands.length).toBeGreaterThan(0)
  })
})

describe("element-center calibration", () => {
  test("element-derived centers pass through the calibration transform", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-cal-test-"))
    const calibration = new CalibrationManager({ file: join(dir, "calibration.json") })
    calibration.status({ width: 2000, height: 1000 })
    calibration.save({
      screen: { width: 2000, height: 1000 },
      scaleX: 2,
      scaleY: 2,
      offsetX: 0,
      offsetY: 0,
      samples: 5,
      measuredAt: Date.now(),
    })
    let hovered: { x: number; y: number } | undefined
    const driver = baseDriver({
      observe: async () => ({
        id: "obs-1",
        elements: [{ id: "el-1", role: "button", name: "B", bounds: { x: 100, y: 100, width: 100, height: 100 } }],
      }),
      hoverPointer: async (x, y) => {
        hovered = { x, y }
        return { success: true, status: "success", message: "hovered" }
      },
    })
    const { manager } = createManager(driver, { calibration })
    const outcome = await manager.execute("local", { action: "hover", target: { elementId: "el-1" } })
    expect(outcome.httpStatus).toBe(200)
    expect(hovered).toEqual({ x: 75, y: 75 })
  })

  test("explicit coordinates are not double-calibrated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-cal-test-"))
    const calibration = new CalibrationManager({ file: join(dir, "calibration.json") })
    calibration.status({ width: 2000, height: 1000 })
    calibration.save({
      screen: { width: 2000, height: 1000 },
      scaleX: 2,
      scaleY: 2,
      offsetX: 0,
      offsetY: 0,
      samples: 5,
      measuredAt: Date.now(),
    })
    let hovered: { x: number; y: number } | undefined
    const driver = baseDriver({
      hoverPointer: async (x, y) => {
        hovered = { x, y }
        return { success: true, status: "success", message: "hovered" }
      },
    })
    const { manager } = createManager(driver, { calibration })
    await manager.execute("local", { action: "hover", x: 150, y: 150 })
    expect(hovered).toEqual({ x: 150, y: 150 })
  })
})

describe("button validation and capability sanitizing", () => {
  test("unknown mouse buttons are rejected instead of mapped to left", async () => {
    let downCalls = 0
    const driver = baseDriver({
      mouseDown: async () => {
        downCalls += 1
        return { success: true, status: "success", message: "down" }
      },
    })
    const { manager } = createManager(driver)
    const rejected = await manager.execute("local", { action: "mouse_down", button: "side" })
    expect(rejected.httpStatus).toBe(400)
    expect(errorCode(rejected.result.error)).toBe("invalid_action")
    expect(downCalls).toBe(0)
    const left = await manager.execute("local", { action: "mouse_down", button: "left" })
    expect(left.httpStatus).toBe(200)
    expect(downCalls).toBe(1)
  })

  test("malformed capability entries are dropped", async () => {
    const malformed = [
      { capability: "accessibility", status: "available" },
      { status: "available" },
      null,
      { capability: "input", status: "not-a-state" },
    ]
    const driver = baseDriver({
      capabilities: (() => malformed) as unknown as () => readonly CapabilitySupport[],
    })
    const { manager } = createManager(driver)
    expect(await manager.capabilities("local")).toEqual([{ capability: "accessibility", status: "available" }])
  })

  test("summary does not report the global permission map per computer", async () => {
    const { manager } = createManager(baseDriver())
    const summary = await manager.summary("local")
    expect(summary).toBeDefined()
    expect(summary !== undefined && "permissions" in summary).toBe(false)
  })
})

describe("menu, paste, clipboard, and wait verification", () => {
  test("executeMenu verifies every item individually", async () => {
    let count = 0
    const driver = baseDriver({
      find: async (request) => ({
        query: request.query,
        matches: [{ element: { id: `m${count}`, role: "menuitem", name: request.query }, score: 1 }],
      }),
      execute: async (action) => {
        count += 1
        return {
          success: true,
          status: "success",
          message: `Executed ${action.type}.`,
          observation: {
            id: `obs-${count}`,
            elements: Array.from({ length: count }, (_, index) => ({
              id: `item-${index}`,
              role: "menuitem",
              name: `item ${index}`,
            })),
          },
        }
      },
    })
    const { manager } = createManager(driver)
    const outcome = await manager.execute("local", { action: "menu", query: "File > Open" })
    expect(outcome.httpStatus).toBe(200)
    expect(outcome.result.verification?.status).toBe("verified")
    expect(outcome.result.verification?.method).toBe("menu-item-diff")
  })

  test("executeMenu fails the item whose click shows no state change", async () => {
    const fixed: Observation = { id: "obs-1", elements: [{ id: "x", role: "menuitem", name: "File" }] }
    const driver = baseDriver({
      find: async (request) => ({
        query: request.query,
        matches: [{ element: { id: `m-${request.query}`, role: "menuitem", name: request.query }, score: 1 }],
      }),
      execute: async (action) => ({
        success: true,
        status: "success",
        message: `Executed ${action.type}.`,
        observation: fixed,
      }),
    })
    const { manager } = createManager(driver)
    const outcome = await manager.execute("local", { action: "menu", query: "File > Open" })
    expect(outcome.httpStatus).toBe(409)
    expect(errorCode(outcome.result.error)).toBe("menu_item_unverified")
    expect(outcome.result.verification?.status).toBe("unverified")
  })

  test("write_clipboard and paste_table read their result back", async () => {
    let clipboard = ""
    const driver = baseDriver({
      writeClipboard: async (text) => {
        clipboard = text
        return { success: true, status: "success", message: "wrote" }
      },
      readClipboard: async () => ({
        success: true,
        status: "success",
        message: "read",
        text: clipboard,
        length: clipboard.length,
        hash: "h",
      }),
      readText: async () => ({ success: true, status: "success", message: "read", text: "prefix a\tb suffix" }),
      execute: async (action) => ({ success: true, status: "success", message: `Executed ${action.type}.` }),
    })
    const { manager } = createManager(driver)
    const write = await manager.execute("local", { action: "write_clipboard", text: "hello" })
    expect(write.result.verification?.status).toBe("verified")
    expect(write.result.verification?.method).toBe("clipboard-readback")

    const paste = await manager.execute("local", {
      action: "paste_table",
      text: "a\tb",
      target: { elementId: "el-1" },
    })
    expect(paste.result.verification?.status).toBe("verified")
    expect(paste.result.verification?.method).toBe("text-readback")
  })

  test("write_clipboard reports unverified when the readback disagrees", async () => {
    const driver = baseDriver({
      writeClipboard: async () => ({ success: true, status: "success", message: "wrote" }),
      readClipboard: async () => ({ success: true, status: "success", message: "read", text: "something else" }),
    })
    const { manager } = createManager(driver)
    const outcome = await manager.execute("local", { action: "write_clipboard", text: "hello" })
    expect(outcome.result.verification?.status).toBe("unverified")
  })

  test("wait verifies by re-observing the environment", async () => {
    const observe = baseDriver({
      observe: async () => ({ id: "obs-1", elements: [{ id: "a", role: "button", name: "A" }] }),
    })
    const verified = await createManager(observe).manager.execute("local", { action: "wait", amount: 10 })
    expect(verified.result.verification?.status).toBe("verified")
    expect(verified.result.verification?.method).toBe("observation-readback")

    const blind = baseDriver({
      observe: async () => {
        throw new Error("runtime down")
      },
    })
    const unverified = await createManager(blind).manager.execute("local", { action: "wait", amount: 10 })
    expect(unverified.result.verification?.status).toBe("unverified")
    expect(unverified.result.verification?.method).toBe("observation-readback")
  })
})

describe("window slug fallback", () => {
  test("loose substring slug matches never focus a window", async () => {
    const driver = baseDriver({
      observe: async () => ({
        id: "obs-1",
        elements: [{ id: "w1", role: "window", name: "Kitty", states: [] }],
      }),
      execute: async (action) => ({ success: true, status: "success", message: `Executed ${action.type}.` }),
    })
    const { manager } = createManager(driver)
    const loose = await manager.execute("local", {
      action: "focus_window",
      window: "no such app",
      target: { elementId: "cua:window/kitty/itt/1" },
    })
    expect(loose.httpStatus).toBe(404)
    expect(errorCode(loose.result.error)).toBe("window_not_found")
  })

  test("an exact slug still recovers a stale ref", async () => {
    const actions: ComputerAction[] = []
    const driver = baseDriver({
      observe: async () => ({
        id: "obs-1",
        elements: [{ id: "w1", role: "window", name: "Kitty", states: [] }],
      }),
      execute: async (action) => {
        actions.push(action)
        return { success: true, status: "success", message: `Executed ${action.type}.` }
      },
    })
    const { manager } = createManager(driver)
    const outcome = await manager.execute("local", {
      action: "focus_window",
      window: "no such app",
      target: { elementId: "cua:window/app/kitty/1" },
    })
    expect(outcome.httpStatus).toBe(200)
    expect(actions[0]).toMatchObject({ type: "focus", target: { kind: "element", elementId: "w1" } })
  })
})

describe("actions the real drivers accept", () => {
  // The production Linux driver rejects any action that fails isComputerAction
  // with invalid_action, so a server that emits a technically malformed target
  // breaks every focus path (focus_window, activate_app, element focus).
  test("focus_window emits an action a real driver accepts", async () => {
    const actions: ComputerAction[] = []
    const driver = baseDriver({
      observe: async () => ({
        id: "obs-1",
        elements: [{ id: "w1", role: "window", name: "Downloads", states: [] }],
      }),
      execute: async (action) => {
        actions.push(action)
        return { success: true, status: "success", message: `Executed ${action.type}.` }
      },
    })
    const { manager } = createManager(driver)
    const outcome = await manager.execute("local", { action: "focus_window", window: "Downloads" })
    expect(outcome.httpStatus).toBe(200)
    expect(actions).toHaveLength(1)
    expect(isComputerAction(actions[0])).toBe(true)
  })

  test("activate_app emits an action a real driver accepts", async () => {
    const actions: ComputerAction[] = []
    const driver = baseDriver({
      observe: async () => ({
        id: "obs-1",
        elements: [{ id: "w1", role: "window", name: "Files", metadata: { application: "dolphin" }, states: [] }],
      }),
      execute: async (action) => {
        actions.push(action)
        return { success: true, status: "success", message: `Executed ${action.type}.` }
      },
    })
    const { manager } = createManager(driver)
    const outcome = await manager.execute("local", { action: "activate_app", app: "dolphin", approve: true, approvedScopes: ["PROCESS_EXECUTE"] })
    expect(outcome.httpStatus).toBe(200)
    expect(isComputerAction(actions[0])).toBe(true)
  })

  test("an element focus with an observation binding is accepted", async () => {
    const actions: ComputerAction[] = []
    const driver = baseDriver({
      observe: async () => ({
        id: "obs-1",
        elements: [{ id: "b1", role: "button", name: "Save", states: [] }],
      }),
      execute: async (action) => {
        actions.push(action)
        return { success: true, status: "success", message: `Executed ${action.type}.` }
      },
    })
    const { manager } = createManager(driver)
    const outcome = await manager.execute("local", {
      action: "focus",
      target: { elementId: "b1", observationId: "obs-1", role: "button" },
    })
    expect(outcome.httpStatus).toBe(200)
    expect(isComputerAction(actions[0])).toBe(true)
  })
})

describe("identity cache bounds", () => {
  test("the cache is evicted, not wholesale cleared, at the cap", async () => {
    const elements = Array.from({ length: 50010 }, (_, index) => ({
      id: `el-${index}`,
      role: "button",
      name: `Element ${index}`,
    }))
    const driver = baseDriver({ observe: async () => ({ id: "obs-1", elements }) })
    const { manager } = createManager(driver)
    await manager.observe("local")
    const identities = (manager as unknown as { identities: Map<string, unknown> }).identities
    expect(identities.size).toBeGreaterThan(0)
    expect(identities.size).toBeLessThanOrEqual(50000)
    // The most recent elements survive; the oldest were evicted.
    expect(identities.has("local:el-50009")).toBe(true)
    expect(identities.has("local:el-0")).toBe(false)
  })
})

describe("target-scoped outcome verification", () => {
  test("an unrelated element change cannot verify a targeted action", async () => {
    const driver = baseDriver({
      observe: async () => ({
        id: "obs-1",
        elements: [
          { id: "el-1", role: "textbox", name: "Field", value: "before", states: [] },
          { id: "el-2", role: "status", name: "Clock", value: "12:00", states: [] },
        ],
      }),
      execute: async () => ({
        success: true,
        status: "success",
        message: "set",
        observation: {
          id: "obs-2",
          elements: [
            { id: "el-1", role: "textbox", name: "Field", value: "before", states: [] },
            { id: "el-2", role: "status", name: "Clock", value: "12:01", states: [] },
          ],
        },
      }),
    })
    const { manager } = createManager(driver)
    await manager.observe("local")
    const outcome = await manager.execute("local", { action: "set_value", target: { elementId: "el-1" }, text: "after" })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.verification?.status).toBe("unverified")
    expect(outcome.result.verification?.message).toContain("el-1")
  })

  test("the target's own change verifies with target-scoped evidence", async () => {
    const driver = baseDriver({
      observe: async () => ({
        id: "obs-1",
        elements: [
          { id: "el-1", role: "textbox", name: "Field", value: "before", states: [] },
          { id: "el-2", role: "status", name: "Clock", value: "12:00", states: [] },
        ],
      }),
      execute: async () => ({
        success: true,
        status: "success",
        message: "set",
        observation: {
          id: "obs-2",
          elements: [
            { id: "el-1", role: "textbox", name: "Field", value: "after", states: [] },
            { id: "el-2", role: "status", name: "Clock", value: "12:01", states: [] },
          ],
        },
      }),
    })
    const { manager } = createManager(driver)
    await manager.observe("local")
    const outcome = await manager.execute("local", { action: "set_value", target: { elementId: "el-1" }, text: "after" })
    expect(outcome.result.verification?.status).toBe("verified")
    expect(outcome.result.verification?.method).toBe("observation-diff")
    expect(outcome.result.verification?.evidence?.[1]?.value).toContain('"target":"el-1"')
  })
})

describe("driver self-verification must be an independent readback", () => {
  test("a non-readback verified claim is ignored and the server fails closed", async () => {
    const driver = baseDriver({
      observe: async () => ({ id: "obs-1", elements: [{ id: "el-1", role: "button", name: "Export", states: [] }] }),
      execute: async () => ({
        success: true,
        status: "success",
        message: "clicked",
        verification: { status: "verified", method: "driver", message: "The driver claims it clicked." },
      }),
    })
    const { manager } = createManager(driver)
    await manager.observe("local")
    const outcome = await manager.execute("local", { action: "click", target: { elementId: "el-1" } })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.verification?.status).toBe("unverified")
    expect(outcome.result.verification?.method).not.toBe("driver")
  })

  test("an independent readback method is trusted driver evidence", async () => {
    const driver = baseDriver({
      observe: async () => ({ id: "obs-1", elements: [{ id: "el-1", role: "button", name: "Export", states: [] }] }),
      execute: async () => ({
        success: true,
        status: "success",
        message: "clicked",
        verification: { status: "verified", method: "observation-readback", message: "The engine re-read the tree." },
      }),
    })
    const { manager } = createManager(driver)
    await manager.observe("local")
    const outcome = await manager.execute("local", { action: "click", target: { elementId: "el-1" } })
    expect(outcome.result.verification?.status).toBe("verified")
    expect(outcome.result.verification?.method).toBe("observation-readback")
  })
})

describe("stored observation completeness metadata", () => {
  test("observations past the storage cap are marked truncated with stored/seen counts", async () => {
    const elements: Observation["elements"] = Array.from({ length: 2001 }, (_, index) => ({
      id: `bulk-${index}`,
      role: "status",
      name: `Item ${index}`,
      states: [],
    }))
    const driver = baseDriver({
      observe: async () => ({ id: "obs-1", elements }),
      execute: async () => ({ success: true, status: "success", message: "clicked", observation: { id: "obs-2", elements } }),
    })
    const { manager } = createManager(driver)
    await manager.observe("local")
    const outcome = await manager.execute("local", { action: "click", x: 5, y: 5 })
    expect(outcome.result.success).toBe(true)
    // The stored before was cut at 2000 of 2001 elements; the element beyond
    // the silent-slice cut must not read as newly added.
    expect(outcome.result.verification?.status).toBe("unverified")
    expect(outcome.result.verification?.message).toContain("incomplete")
    const stored = (manager as unknown as { computers: Map<string, { lastObservation?: Observation }> }).computers.get("local")
      ?.lastObservation
    expect(stored?.elements).toHaveLength(2000)
    const metadata = stored?.metadata as Record<string, unknown> | undefined
    expect(metadata?.["truncated"]).toBe(true)
    expect(metadata?.["stored"]).toBe(2000)
    expect(metadata?.["seen"]).toBe(2001)
  })
})

describe("plans contract", () => {
  const unverifiedDriver = () =>
    baseDriver({
      observe: async () => ({ id: "obs-1", elements: [{ id: "el-1", role: "button", name: "Export", states: [] }] }),
      execute: async () => ({ success: true, status: "success", message: "clicked" }),
    })

  test("an unverified step fails the plan by default", async () => {
    const { manager } = createManager(unverifiedDriver())
    await manager.observe("local")
    const outcome = await manager.executeBatch("local", {
      steps: [{ action: "click", target: { elementId: "el-1" } }],
    })
    expect(outcome.result.success).toBe(false)
    expect(outcome.result.verified).toBe(false)
    expect(outcome.result.steps[0]?.success).toBe(false)
    expect(outcome.result.steps[0]?.verified).toBe(false)
    expect(errorCode(outcome.result.steps[0]?.error)).toBe("unverified")
    expect(outcome.result.steps[0]?.message).toContain("not verified")
  })

  test("allowUnverified lets an opted-out step pass but never marks it verified", async () => {
    const { manager } = createManager(unverifiedDriver())
    await manager.observe("local")
    const outcome = await manager.executeBatch("local", {
      steps: [{ action: "click", target: { elementId: "el-1" }, allowUnverified: true }],
    })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.verified).toBe(false)
    expect(outcome.result.steps[0]?.success).toBe(true)
    expect(outcome.result.steps[0]?.verified).toBe(false)
    expect(outcome.result.steps[0]?.allowUnverified).toBe(true)
    expect(outcome.result.steps[0]?.error).toBeUndefined()
  })

  test("a verified plan exposes verified on the batch result and every step", async () => {
    const driver = baseDriver({
      observe: async () => ({ id: "obs-1", elements: [{ id: "el-1", role: "button", name: "Export", states: [] }] }),
      execute: async () => ({
        success: true,
        status: "success",
        message: "clicked",
        observation: { id: "obs-2", elements: [{ id: "el-1", role: "button", name: "Export", states: ["pressed"] }] },
      }),
    })
    const { manager } = createManager(driver)
    await manager.observe("local")
    const outcome = await manager.executeBatch("local", {
      steps: [{ action: "click", target: { elementId: "el-1" } }],
    })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.verified).toBe(true)
    expect(outcome.result.steps[0]?.success).toBe(true)
    expect(outcome.result.steps[0]?.verified).toBe(true)
    expect(outcome.result.steps[0]?.error).toBeUndefined()
  })
})

describe("an unimplemented expectation is never evidence", () => {
  const clickDriver = () =>
    baseDriver({
      observe: async () => ({ id: "obs-1", elements: [{ id: "el-1", role: "button", name: "Export", states: [] }] }),
      execute: async () => ({
        success: true,
        status: "success",
        message: "clicked",
        observation: { id: "obs-2", elements: [{ id: "el-1", role: "button", name: "Export", states: ["pressed"] }] },
      }),
    })

  test("an empty expectation does not verify the step", async () => {
    const { manager } = createManager(clickDriver())
    await manager.observe("local")
    const outcome = await manager.executeBatch("local", {
      steps: [{ action: "click", target: { elementId: "el-1" }, expect: {} }],
    })
    expect(outcome.result.success).toBe(false)
    expect(outcome.result.steps[0]?.verified).toBe(false)
    expect(errorCode(outcome.result.steps[0]?.error)).toBe("expectation_unmet")
    expect(outcome.result.steps[0]?.message).toContain("no expectation")
  })

  test("an expectation this computer cannot verify does not verify the step", async () => {
    const { manager } = createManager(clickDriver())
    await manager.observe("local")
    const outcome = await manager.executeBatch("local", {
      steps: [{ action: "click", target: { elementId: "el-1" }, expect: { urlContains: "/account" } }],
    })
    expect(outcome.result.success).toBe(false)
    expect(outcome.result.steps[0]?.verified).toBe(false)
    expect(errorCode(outcome.result.steps[0]?.error)).toBe("expectation_unmet")
    expect(outcome.result.steps[0]?.message).toContain("urlContains")
  })
})

describe("a step whose action returns no verification is unverified", () => {
  const hoverDriver = () =>
    baseDriver({
      observe: async () => ({ id: "obs-1", elements: [] }),
      hoverPointer: async () => ({ success: true, status: "success", message: "hovered" }),
      mouseDown: async () => ({ success: true, status: "success", message: "pressed" }),
      mouseUp: async () => ({ success: true, status: "success", message: "released" }),
      releaseStuckKeys: async () => ({ success: true, status: "success", message: "reset" }),
    })

  test("hover is not verified by its own success and fails the plan by default", async () => {
    const { manager } = createManager(hoverDriver())
    await manager.observe("local")
    const outcome = await manager.executeBatch("local", { steps: [{ action: "hover", x: 5, y: 5 }] })
    expect(outcome.result.success).toBe(false)
    expect(outcome.result.verified).toBe(false)
    expect(outcome.result.steps[0]?.success).toBe(false)
    expect(outcome.result.steps[0]?.verified).toBe(false)
    expect(errorCode(outcome.result.steps[0]?.error)).toBe("unverified")
    expect(outcome.result.steps[0]?.verification?.status).toBe("unverified")
    expect(outcome.result.steps[0]?.message).toContain("independent readback")
  })

  test("mouse_down, mouse_up, and release_keys stay unverified too", async () => {
    const { manager } = createManager(hoverDriver())
    await manager.observe("local")
    const outcome = await manager.executeBatch("local", {
      steps: [{ action: "mouse_down" }, { action: "mouse_up" }, { action: "release_keys" }],
      stopOnError: false,
    })
    expect(outcome.result.success).toBe(false)
    expect(outcome.result.steps.map((step) => step.verified)).toEqual([false, false, false])
    expect(outcome.result.steps[0]?.error).toMatchObject({ code: "unverified" })
  })

  test("allowUnverified still reports the step as unverified", async () => {
    const { manager } = createManager(hoverDriver())
    await manager.observe("local")
    const outcome = await manager.executeBatch("local", {
      steps: [{ action: "hover", x: 5, y: 5, allowUnverified: true }],
    })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.verified).toBe(false)
    expect(outcome.result.steps[0]?.success).toBe(true)
    expect(outcome.result.steps[0]?.verified).toBe(false)
    expect(outcome.result.steps[0]?.allowUnverified).toBe(true)
  })
})

describe("typed text needs a pre-read it can compare against", () => {
  test("a failed pre-read leaves typing unverified", async () => {
    let reads = 0
    const driver = baseDriver({
      observe: async () => ({ id: "obs-1", elements: [{ id: "el-1", role: "textbox", name: "Field", value: "hello", states: [] }] }),
      execute: async () => ({ success: true, status: "success", message: "typed" }),
      readText: async () => {
        reads += 1
        return reads === 1
          ? { success: false, status: "failed", message: "The target could not be read." }
          : { success: true, status: "success", message: "read", text: "hello", length: 5, hash: "h" }
      },
    })
    const { manager } = createManager(driver)
    await manager.observe("local")
    const outcome = await manager.execute("local", { action: "type", target: { elementId: "el-1" }, text: "hello" })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.verification?.status).not.toBe("verified")
  })

  test("a successful pre-read plus a matching readback still verifies", async () => {
    let reads = 0
    const driver = baseDriver({
      observe: async () => ({ id: "obs-1", elements: [{ id: "el-1", role: "textbox", name: "Field", value: "", states: [] }] }),
      execute: async () => ({ success: true, status: "success", message: "typed" }),
      readText: async () => {
        reads += 1
        return reads === 1
          ? { success: true, status: "success", message: "read", text: "", length: 0, hash: "h" }
          : { success: true, status: "success", message: "read", text: "hello", length: 5, hash: "h" }
      },
    })
    const { manager } = createManager(driver)
    await manager.observe("local")
    const outcome = await manager.execute("local", { action: "type", target: { elementId: "el-1" }, text: "hello" })
    expect(outcome.result.verification?.status).toBe("verified")
    expect(outcome.result.verification?.method).toBe("text-readback")
  })
})

describe("a clipboard readback never verifies a paste", () => {
  test("a targetless paste with the TSV still on the clipboard stays unverified", async () => {
    let clipboard = ""
    const driver = baseDriver({
      writeClipboard: async (text) => {
        clipboard = text
        return { success: true, status: "success", message: "wrote" }
      },
      readClipboard: async () => ({
        success: true,
        status: "success",
        message: "read",
        text: clipboard,
        length: clipboard.length,
        hash: "h",
      }),
      execute: async (action) => ({ success: true, status: "success", message: `Executed ${action.type}.` }),
    })
    const { manager } = createManager(driver)
    const outcome = await manager.execute("local", { action: "paste_table", text: "a\tb" })
    expect(outcome.result.verification?.status).toBe("unverified")
    expect(outcome.result.verification?.method).toBe("clipboard-readback")
  })

  test("an unreadable target falls back to the clipboard and stays unverified", async () => {
    let clipboard = ""
    const driver = baseDriver({
      writeClipboard: async (text) => {
        clipboard = text
        return { success: true, status: "success", message: "wrote" }
      },
      readClipboard: async () => ({
        success: true,
        status: "success",
        message: "read",
        text: clipboard,
        length: clipboard.length,
        hash: "h",
      }),
      readText: async () => ({ success: false, status: "failed", message: "The target could not be read." }),
      execute: async (action) => ({ success: true, status: "success", message: `Executed ${action.type}.` }),
    })
    const { manager } = createManager(driver)
    const outcome = await manager.execute("local", {
      action: "paste_table",
      text: "a\tb",
      target: { elementId: "el-1" },
    })
    expect(outcome.result.verification?.status).toBe("unverified")
  })
})
