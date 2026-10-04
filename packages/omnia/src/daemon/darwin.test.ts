import { describe, expect, test } from "bun:test"
import { DarwinHostDriver } from "./darwin"

// The shipped shell is /bin/zsh, which does not exist off macOS. The driver
// accepts a shell override so the command boundary can be exercised on POSIX
// CI with /bin/sh; the guard branches never spawn anything.
function testDriver() {
  return new DarwinHostDriver({ shell: "/bin/sh" })
}

describe("macOS command boundary", () => {
  test("rejects a missing working directory", async () => {
    const result = await testDriver().runCommand({ command: "true", cwd: "/definitely/not/a/directory" })
    expect(result.success).toBe(false)
    expect(typeof result.error === "object" ? result.error.code : undefined).toBe("invalid_cwd")
  })

  test("rejects a working directory that is a file", async () => {
    const result = await testDriver().runCommand({ command: "true", cwd: "/etc/hosts" })
    expect(result.success).toBe(false)
    expect(typeof result.error === "object" ? result.error.code : undefined).toBe("invalid_cwd")
  })

  test("rejects environment overrides", async () => {
    for (const key of ["PATH", "DISPLAY", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "NODE_OPTIONS"]) {
      const result = await testDriver().runCommand({ command: "true", env: { [key]: "evil" } })
      expect(result.success).toBe(false)
      expect(typeof result.error === "object" ? result.error.code : undefined).toBe("invalid_env")
    }
  })
})

const describeShell = process.platform === "win32" ? describe.skip : describe

describeShell("macOS command execution", () => {
  test("captures output, exit codes, and stdin", async () => {
    const host = testDriver()
    const result = await host.runCommand({ command: "printf omnia-darwin" })
    expect(result.success).toBe(true)
    expect(result.command?.stdout).toBe("omnia-darwin")

    const failed = await host.runCommand({ command: "sh -c 'echo problem >&2; exit 3'" })
    expect(failed.success).toBe(false)
    expect(failed.command?.exitCode).toBe(3)
    expect(failed.command?.stderr).toContain("problem")

    const fed = await host.runCommand({ command: "cat", stdin: "secret\n" })
    expect(fed.command?.stdout).toBe("secret\n")
  })

  test("caps oversized output", async () => {
    const result = await testDriver().runCommand({
      command: "head -c 20000 /dev/zero | tr '\\0' 'a'",
      maxOutputBytes: 4096,
    })
    expect(result.command?.truncated).toBe(true)
    expect(result.command?.stdout.length).toBeLessThanOrEqual(4096)
  })

  test("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const started = Date.now()
    const result = await testDriver().runCommand({ command: "trap '' TERM; exec sleep 10", timeoutMs: 1000 })
    expect(result.success).toBe(false)
    expect(result.command?.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(6000)
  }, 10000)

  test("captures child stdin errors in CommandResult", async () => {
    const result = await testDriver().runCommand({
      command: "sh -c 'exec 0<&-; sleep 0.5'",
      stdin: "z".repeat(1024 * 1024),
    })
    expect(result.success).toBe(true)
    expect(result.command?.stdinError).toContain("EPIPE")
  }, 10000)
})
