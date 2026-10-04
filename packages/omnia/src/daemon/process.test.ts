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
