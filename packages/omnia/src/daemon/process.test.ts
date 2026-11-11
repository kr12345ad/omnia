import { describe, expect, test } from "bun:test"
import { executeShellCommand, runProcessWithInput } from "./process"

describe("daemon process helpers", () => {
  test("delivers stdin and captures stdout", async () => {
    const result = await runProcessWithInput("cat", [], "hello stdin", 5000)
    expect(result.code).toBe(0)
    expect(result.stdout).toBe("hello stdin")
    expect(result.timedOut).toBe(false)
  })

  test("caps oversized output instead of buffering without limit", async () => {
    const result = await runProcessWithInput(
      "sh",
      ["-c", "head -c 4096 /dev/zero | tr '\\0' 'a'"],
      "",
      5000,
      1024,
    )
    expect(result.truncated).toBe(true)
    expect(result.stdout.length).toBeLessThanOrEqual(1024)
  })

  test("survives EPIPE when the child exits before reading stdin", async () => {
    const result = await runProcessWithInput("sh", ["-c", "exit 0"], "x".repeat(4 * 1024 * 1024), 5000)
    expect(result.code).toBe(0)
  })

  test("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const started = Date.now()
    const result = await executeShellCommand(
      { command: "trap '' TERM; exec sleep 10", timeoutMs: 1000 },
      { file: "/bin/sh", args: (command) => ["-c", command] },
    )
    expect(result.success).toBe(false)
    expect(result.command?.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(6000)
  }, 10000)

  test("does not crash on EPIPE for shell command stdin", async () => {
    const result = await executeShellCommand(
      { command: "true", stdin: "y".repeat(2 * 1024 * 1024) },
      { file: "/bin/sh", args: (command) => ["-c", command] },
    )
    expect(result.success).toBe(true)
  })
})

test("times out a shell whose descendants retain the output pipes", async () => {
  const started = Date.now()
  const result = await executeShellCommand(
    { command: "sleep 20 & wait", timeoutMs: 1000 },
    { file: "/bin/sh", args: (command) => ["-c", command] },
  )
  expect(result.command?.timedOut).toBe(true)
  expect(Date.now() - started).toBeLessThan(5000)
}, 7000)

test("input helper terminates descendant processes on timeout", async () => {
  const started = Date.now()
  const result = await runProcessWithInput("/bin/sh", ["-c", "sleep 20 & wait"], "", 100)
  expect(result.timedOut).toBe(true)
  expect(Date.now() - started).toBeLessThan(4000)
}, 6000)


test("Windows skips exited children while POSIX still signals their process groups", () => {
  const script = `
    Object.defineProperty(process, "platform", { value: "win32" })
    const { terminateProcessTree } = await import(${JSON.stringify(new URL("./process.ts", import.meta.url).href)})
    for (const state of [{ exitCode: 0, signalCode: null }, { exitCode: null, signalCode: "SIGTERM" }]) {
      terminateProcessTree({ pid: 999, ...state, kill() { throw new Error("an exited Windows PID was targeted") } }, "SIGKILL")
    }
    Object.defineProperty(process, "platform", { value: "linux" })
    let group
    process.kill = (pid) => { group = pid; return true }
    terminateProcessTree({ pid: 999, exitCode: 0, signalCode: null }, "SIGKILL")
    if (group !== -999) throw new Error("an exited POSIX group leader suppressed descendant cleanup")
    await Bun.sleep(50)
  `
  const result = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
})
