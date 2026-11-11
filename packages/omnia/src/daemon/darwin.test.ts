import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DarwinHostDriver } from "./darwin"

// The shipped shell is /bin/zsh, which does not exist off macOS. The driver
// accepts a shell override so the command boundary can be exercised on POSIX
// CI with /bin/bash (dash cannot load the sandbox login profile); the guard branches never spawn anything.
function testDriver() {
  return new DarwinHostDriver({ shell: "/bin/bash" })
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

  test("rejects loader and startup env overrides before shell execution", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omnia-darwin-env-"))
    const probe = join(directory, "spawned")
    const host = testDriver()
    try {
      for (const key of [
        "PATH", "DISPLAY", "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "LD_FUTURE_OPTION",
        "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH", "DYLD_FUTURE_OPTION",
        "BASH_ENV", "ENV", "SHELLOPTS", "NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "PYTHONHOME",
        "RUBYOPT", "RUBYLIB", "PERL5OPT", "PERL5LIB", "BUN_OPTIONS", "BUN_FUTURE_OPTION",
      ].flatMap((key) => [key, key.toLowerCase()])) {
        const result = await host.runCommand({ command: `touch ${probe}`, env: { [key]: "" } })
        expect(result.success, key).toBe(false)
        expect(result.error).toMatchObject({ code: "invalid_env", retryable: false })
        expect(result.command).toBeUndefined()
        expect(existsSync(probe)).toBe(false)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("rejects malformed env names and NUL values without exposing values", async () => {
    const host = testDriver()
    for (const env of [
      ...["", "1KEY", "BAD=KEY", "BAD-KEY", "BAD KEY", "BAD\nKEY", "KEY\n", "BAD\0KEY", "éKEY"]
        .map((key) => ({ [key]: "private-value" })),
      { VALID_KEY: "\0private-value" },
      { VALID_KEY: "private-value\0tail" },
      { VALID_KEY: "private-value\0" },
    ]) {
      const result = await host.runCommand({ command: "true", env })
      expect(result.error).toMatchObject({ code: "invalid_env", retryable: false })
      expect(result.command).toBeUndefined()
      expect(JSON.stringify(result)).not.toContain("private-value")
    }
  })
})

const describeShell = process.platform === "win32" ? describe.skip : describe

describe("macOS paid primitive enforcement", () => {
  // Nothing here spawns: on a free paired computer the refusal replaces the
  // dispatch, so there is no /bin/zsh and no pbpaste/pbcopy to observe.
  test("refuses remote_shell and the clipboard on a free paired computer", async () => {
    const host = new DarwinHostDriver({ shell: "/bin/bash", access: { surface: "paired", plan: "free" } })
    const command = await host.runCommand({ command: "printf never" })
    expect(command.success).toBe(false)
    expect(command.command).toBeUndefined()
    expect(command.error).toMatchObject({ code: "capability_not_entitled", retryable: false })
    expect(command.message).toContain("remote_shell")
    expect(command.message).toContain("free")
  })

  // The clipboard is free on every platform now, so asserting it means actually
  // dispatching pbpaste/pbcopy - which only exist on macOS. The refusal half
  // above stays platform-independent because it never spawns anything.
  describeShell("macOS free clipboard", () => {
    test("the clipboard is free on a paired computer", async () => {
      const host = new DarwinHostDriver({ shell: "/bin/bash", access: { surface: "paired", plan: "free" } })
      const read = await host.readClipboard()
      expect(read.success).toBe(true)
      expect(read.error).toBeUndefined()
    })
  })
})

describeShell("macOS paid primitive local path", () => {
  test("an undeclared driver is local and still runs commands", async () => {
    const result = await testDriver().runCommand({ command: "printf omnia-local" })
    expect(result.success).toBe(true)
    expect(result.command?.stdout).toBe("omnia-local")
  })
})

describeShell("macOS screen info", () => {
  function fakeExecutable(directory: string, name: string, body: string): string {
    const path = join(directory, name)
    writeFileSync(path, body)
    chmodSync(path, 0o755)
    return path
  }

  test("info() carries screen when the script succeeds", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omnia-darwin-screen-"))
    try {
      const driver = new DarwinHostDriver({
        shell: "/bin/bash",
        osascript: fakeExecutable(directory, "osascript", '#!/bin/sh\necho \'{"width":1512,"height":944}\'\n'),
      })
      const info = await driver.info()
      expect(info.screen).toEqual({ width: 1512, height: 944 })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("info() omits screen when the script fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omnia-darwin-screen-"))
    try {
      const driver = new DarwinHostDriver({
        shell: "/bin/bash",
        osascript: fakeExecutable(directory, "osascript", "#!/bin/sh\nexit 1\n"),
      })
      const info = await driver.info()
      expect(info.screen).toBeUndefined()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describeShell("macOS command execution", () => {
  test("passes ordinary settings and credentials unchanged to shell commands", async () => {
    const env = {
      _omnia_setting: "spaces 'quotes' = unicode ✓\nsecond line",
      OMNIA_EMPTY: "",
      OMNIA_CREDENTIAL_USERNAME: "alice",
      OMNIA_CREDENTIAL_PASSWORD: "password with spaces",
      OMNIA_CREDENTIAL_TOKEN: "token=value",
    }
    const result = await testDriver().runCommand({
      command: `printf '%s\\n' ${Object.keys(env).map((key) => `"$${key}"`).join(" ")}`,
      env,
    })
    expect(result.success).toBe(true)
    expect(result.command?.stdout).toBe(Object.values(env).join("\n") + "\n")
  })

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

describeShell("macOS native input failures", () => {
  test("press_keys reports native command failure", async () => {
    const host = new DarwinHostDriver({ osascript: "/bin/false", ioreg: "/bin/true" })
    const result = await host.execute({ type: "press_keys", keys: "cmd+a" })
    expect(result.success).toBe(false)
    expect(result.status).toBe("failed")
  })
})
