import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runHeadlessCli } from "./cli"

// A stand-in for the official binary: it accepts the same flags and writes the
// same JSON event lines, so the runner is exercised as a real subprocess rather
// than against a stubbed spawn.
const FIXTURE = `#!/usr/bin/env bun
const args = process.argv.slice(2)
if (process.env.FIXTURE_ARGS) await Bun.write(process.env.FIXTURE_ARGS, JSON.stringify(args))
const mode = process.env.FIXTURE_MODE ?? "answer"
const sessionID = "ses_fixture00000000000000000"
const emit = (event) => console.log(JSON.stringify({ sessionID, ...event }))
if (mode === "sleep") {
  await Bun.sleep(60_000)
  process.exit(0)
}
if (mode === "exit") process.exit(3)
if (mode === "error") {
  emit({ type: "error", error: { type: "provider.auth", message: "OpenCode's free tier is unavailable." } })
  process.exit(0)
}
const at = args.indexOf("--file")
const attached = at === -1 ? "" : await Bun.file(args[at + 1]).text()
emit({ type: "step_start", part: { partID: "prt_1", messageID: "msg_1", type: "step-start" } })
emit({
  type: "tool_use",
  part: { partID: "prt_2", messageID: "msg_1", type: "tool", tool: "shell", state: { status: "completed", title: "pwd" } },
})
emit({ type: "text", part: { id: "prt_3", messageID: "msg_2", type: "text", text: \`pong\${attached}\` } })
`

function fixture(): { bin: string; args: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "omnia-cli-"))
  const bin = join(dir, "opencode")
  writeFileSync(bin, FIXTURE)
  chmodSync(bin, 0o755)
  // The fixture records the argv it was handed, so the flags themselves are
  // asserted rather than inferred from the effects.
  process.env.FIXTURE_ARGS = join(dir, "args.json")
  return {
    bin,
    args: join(dir, "args.json"),
    cleanup: () => {
      delete process.env.FIXTURE_ARGS
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

describe("the CLI headless run", () => {
  test("runs the conversation through the official client and returns its answer", async () => {
    const fake = fixture()
    try {
      const progress: (readonly unknown[])[] = []
      const result = await runHeadlessCli(
        { bin: fake.bin },
        {
          prompt: "the question",
          model: { providerID: "opencode", modelID: "big-pickle" },
          sessionId: "ses_channel1",
          title: "Chat · discord · C1",
          onProgress: (messages) => progress.push(messages),
        },
      )

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.text).toBe("pong")
      expect(result.sessionId).toBe("ses_channel1")
      // Progress reaches the trace as assistant messages, so a tool step is
      // visible while the turn runs.
      expect(progress.length).toBeGreaterThan(0)
      expect(JSON.stringify(progress.at(-1))).toContain("\"tool\":\"shell\"")

      const args: string[] = JSON.parse(readFileSync(fake.args, "utf8"))
      expect(args.slice(0, 4)).toEqual(["run", "--auto", "--format", "json"])
      expect(args).toContain("--model")
      expect(args[args.indexOf("--model") + 1]).toBe("opencode/big-pickle")
      expect(args[args.indexOf("--session") + 1]).toBe("ses_channel1")
      expect(args.at(-1)).toBe("the question")
    } finally {
      fake.cleanup()
    }
  })

  test("keeps the session the CLI opened when the call did not name one", async () => {
    const fake = fixture()
    try {
      const result = await runHeadlessCli({ bin: fake.bin }, { prompt: "hi" })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.sessionId).toBe("ses_fixture00000000000000000")
      const args: string[] = JSON.parse(readFileSync(fake.args, "utf8"))
      expect(args).not.toContain("--session")
    } finally {
      fake.cleanup()
    }
  })

  test("hands an attachment to the CLI as a file it can read", async () => {
    const fake = fixture()
    try {
      const result = await runHeadlessCli(
        { bin: fake.bin },
        {
          prompt: "what is in the file?",
          files: [{ mime: "text/plain", filename: "note.txt", url: `data:text/plain;base64,${btoa("attached text")}` }],
        },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.text).toBe("pongattached text")
    } finally {
      fake.cleanup()
    }
  })

  test("reports a provider error the way the server path does", async () => {
    const fake = fixture()
    process.env.FIXTURE_MODE = "error"
    try {
      const result = await runHeadlessCli({ bin: fake.bin }, { prompt: "hi" })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toContain("free tier")
      expect(result.timedOut).toBe(false)
    } finally {
      delete process.env.FIXTURE_MODE
      fake.cleanup()
    }
  })

  test("a non-zero exit is a failed turn, not an empty answer", async () => {
    const fake = fixture()
    process.env.FIXTURE_MODE = "exit"
    try {
      const result = await runHeadlessCli({ bin: fake.bin }, { prompt: "hi" })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toContain("code 3")
    } finally {
      delete process.env.FIXTURE_MODE
      fake.cleanup()
    }
  })

  test("aborting the turn stops the process", async () => {
    const fake = fixture()
    process.env.FIXTURE_MODE = "sleep"
    const controller = new AbortController()
    try {
      setTimeout(() => controller.abort(), 300)
      const result = await runHeadlessCli({ bin: fake.bin }, { prompt: "hi", signal: controller.signal })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.interrupted).toBe(true)
    } finally {
      delete process.env.FIXTURE_MODE
      fake.cleanup()
    }
  })
})
