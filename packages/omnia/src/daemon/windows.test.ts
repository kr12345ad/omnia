import { describe, expect, test } from "bun:test"
import type { ProcessResult } from "./process"
import { mouseScript, WINDOWS_CLIPBOARD_SET_SCRIPT, WindowsHostDriver } from "./windows"

function captureInputRunner() {
  const calls: Array<{ file: string; args: string[]; input: string }> = []
  const runner = async (file: string, args: readonly string[], input: string): Promise<ProcessResult> => {
    calls.push({ file, args: [...args], input })
    return { stdout: '{"ok":true}', stderr: "", code: 0 }
  }
  return { calls, runner }
}

describe("windows clipboard safety", () => {
  test("passes clipboard text over stdin and never into the PowerShell source", async () => {
    const { calls, runner } = captureInputRunner()
    const host = new WindowsHostDriver({ inputRunner: runner })
    const payload = `"$(calc)" \`Get-Process\` '; Remove-Item C:\\ -Recurse'`
    const result = await host.writeClipboard(payload)
    expect(result.success).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toBe(payload)
    const script = calls[0]?.args.at(-1) ?? ""
    expect(script).toBe(WINDOWS_CLIPBOARD_SET_SCRIPT)
    expect(script).toContain("ReadToEnd")
    expect(script).not.toContain("$(calc)")
    expect(script).not.toContain("Get-Process")
  })

  test("type passes text over stdin and never into the PowerShell source", async () => {
    const { calls, runner } = captureInputRunner()
    const host = new WindowsHostDriver({ inputRunner: runner })
    const payload = '"; Start-Process calc; "`n$(calc)'
    const result = await host.execute({ type: "type", text: payload })
    expect(result.success).toBe(true)
    expect(calls[0]?.input).toBe(payload)
    const script = calls[0]?.args.at(-1) ?? ""
    expect(script).toContain("ReadToEnd")
    expect(script).not.toContain("Start-Process calc")
  })

  test("mouse down and up do not move the pointer to the origin", () => {
    const down = mouseScript("down")
    const up = mouseScript("up")
    expect(down).not.toContain("[OmniaInput]::SetCursorPos(")
    expect(up).not.toContain("[OmniaInput]::SetCursorPos(")
    expect(down).toContain("mouse_event(0x0002")
    expect(up).toContain("mouse_event(0x0004")
  })
})

describe("windows paid primitive enforcement", () => {
  test("the clipboard is free, so PowerShell is allowed to run", async () => {
    const { calls, runner } = captureInputRunner()
    const host = new WindowsHostDriver({ inputRunner: runner, access: { surface: "paired", plan: "free" } })
    const result = await host.writeClipboard("secret")
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
    // The clipboard is free, so the PowerShell that reaches it is actually built
    // and dispatched. The REMOTE SHELL is what still refuses.
    expect(calls.length).toBeGreaterThan(0)
  })

  test("refuses remote_shell before PowerShell is spawned", async () => {
    const host = new WindowsHostDriver({ access: { surface: "paired", plan: "free" } })
    const result = await host.runCommand({ command: "whoami" })
    expect(result.success).toBe(false)
    expect(result.command).toBeUndefined()
    expect(result.error).toMatchObject({ code: "capability_not_entitled" })
    expect(result.message).toContain("remote_shell")
  })
})

const testPosix = process.platform === "win32" ? test.skip : test
for (const type of ["key", "press_keys"] as const) {
  testPosix(`Windows ${type} reports native command failure`, async () => {
    const host = new WindowsHostDriver({ powershell: "/bin/false" })
    const result = await host.execute(type === "key" ? { type, key: "enter" } : { type, keys: "ctrl+a" })
    expect(result.success).toBe(false)
  })
}

testPosix("Windows refuses targeted typing when focus failed", async () => {
  const { calls, runner } = captureInputRunner()
  const host = new WindowsHostDriver({ powershell: "/bin/false", inputRunner: runner })
  const result = await host.execute({ type: "type", text: "private text", target: { kind: "element", elementId: "uia:1" } })
  expect(result.success).toBe(false)
  expect(calls).toHaveLength(0)
})
