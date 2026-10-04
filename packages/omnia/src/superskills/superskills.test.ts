import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SuperskillRegistry, parseSuperskill } from "./registry"
import { SuperskillBridges, splitBridgeCommand } from "./bridge"

const ECHO_SCRIPT = `import json
import sys
import time

for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    if method == "fail":
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "error": {"message": "intentional failure"}}), flush=True)
    elif method == "hang":
        time.sleep(30)
    elif method == "flood":
        sys.stdout.write("x" * 5000000)
        sys.stdout.flush()
        time.sleep(30)
    else:
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": request.get("params")}), flush=True)
`

function writeEchoScript(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnia-superskill-"))
  const path = join(dir, "echo.py")
  writeFileSync(path, ECHO_SCRIPT)
  return path
}

function sampleSkill(command: string) {
  return {
    id: "echo-bridge",
    name: "Echo bridge",
    description: "Test bridge that echoes its params.",
    instructions: "Use ping to echo a value.",
    enabled: true,
    scopes: ["FILES_READ"],
    bridge: { type: "stdio" as const, command: `python3 ${command}`, timeoutMs: 10000 },
    methods: [
      { name: "ping", description: "Echo params back." },
      { name: "fail", description: "Always fails.", scopes: ["FILES_WRITE" as const] },
      { name: "hang", description: "Never answers." },
      { name: "flood", description: "Streams without a newline." },
    ],
  }
}

describe("superskill registry", () => {
  test("parses, validates, saves, and removes superskills", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-superskill-"))
    const registry = new SuperskillRegistry({ file: join(dir, "superskills.json") })
    const saved = registry.save(sampleSkill("/tmp/echo.py"))
    expect(saved.id).toBe("echo-bridge")
    expect(registry.list()).toHaveLength(1)
    expect(registry.get("echo-bridge")?.methods[0]?.name).toBe("ping")
    expect(registry.enabled()).toHaveLength(1)

    registry.save({ ...sampleSkill("/tmp/echo.py"), enabled: false })
    expect(registry.enabled()).toHaveLength(0)

    const reopened = new SuperskillRegistry({ file: join(dir, "superskills.json") })
    expect(reopened.get("echo-bridge")?.name).toBe("Echo bridge")
    expect(reopened.remove("echo-bridge")).toBe(true)
    expect(reopened.remove("echo-bridge")).toBe(false)
  })

  test("rejects malformed superskills", () => {
    expect(() => parseSuperskill({ id: "Bad Id", name: "x", description: "y", bridge: {}, methods: [] })).toThrow()
    expect(() =>
      parseSuperskill({
        id: "no-methods",
        name: "x",
        description: "y",
        bridge: { type: "stdio", command: "echo" },
        methods: [],
      }),
    ).toThrow("at least one method")
    expect(() =>
      parseSuperskill({
        id: "bad-scope",
        name: "x",
        description: "y",
        bridge: { type: "http", url: "http://127.0.0.1:1" },
        methods: [{ name: "m", description: "d", scopes: ["NOT_A_SCOPE"] }],
      }),
    ).toThrow("unknown permission scope")
  })

  test("splits bridge commands with quotes", () => {
    expect(splitBridgeCommand("python3 /tmp/bridge.py")).toEqual(["python3", "/tmp/bridge.py"])
    expect(splitBridgeCommand('flatpak run --command=sh org.example "one two"')).toEqual([
      "flatpak",
      "run",
      "--command=sh",
      "org.example",
      "one two",
    ])
  })
})

describe("superskill bridge", () => {
  test("speaks JSON-RPC over stdio", async () => {
    const bridges = new SuperskillBridges()
    const skill = parseSuperskill(sampleSkill(writeEchoScript()))
    const echoed = await bridges.call(skill, "ping", { value: 42 })
    expect(echoed).toEqual({ value: 42 })
    const second = await bridges.call(skill, "ping", { value: "again" })
    expect(second).toEqual({ value: "again" })
    await expect(bridges.call(skill, "fail", {})).rejects.toThrow("intentional failure")
    bridges.close()
  })
})
import { readFileSync, statSync, writeFileSync as write } from "node:fs"

describe("superskill scopes and persistence hardening", () => {
  test("an empty scopes array defaults to the bridge scopes instead of none", () => {
    const skill = parseSuperskill({
      ...sampleSkill("/tmp/echo.py"),
      scopes: [],
      methods: [{ name: "ping", description: "Echo.", scopes: [] }],
    })
    expect(skill.scopes).toBeUndefined()
    expect(skill.methods[0]?.scopes).toBeUndefined()
  })

  test("persists with owner-only permissions and no empty scopes array", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-superskill-"))
    const file = join(dir, "superskills.json")
    const registry = new SuperskillRegistry({ file })
    registry.save({ ...sampleSkill("/tmp/echo.py"), scopes: [] })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, "utf8")).not.toContain('"scopes": []')
  })

  test("one malformed skill does not drop the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-superskill-"))
    const file = join(dir, "superskills.json")
    write(file, JSON.stringify({ superskills: [{ id: "broken" }, sampleSkill("/tmp/echo.py")] }))
    const registry = new SuperskillRegistry({ file })
    expect(registry.list().map((skill) => skill.id)).toEqual(["echo-bridge"])
  })

  test("clamps bridge timeouts to a finite positive range", () => {
    expect(parseSuperskill({ ...sampleSkill("/tmp/echo.py"), bridge: { type: "stdio", command: "echo", timeoutMs: -5 } }).bridge.timeoutMs).toBe(100)
    expect(parseSuperskill({ ...sampleSkill("/tmp/echo.py"), bridge: { type: "stdio", command: "echo", timeoutMs: Number.POSITIVE_INFINITY } }).bridge.timeoutMs).toBeUndefined()
  })
})

describe("superskill bridge hardening", () => {
  test("preserves empty quoted arguments", () => {
    expect(splitBridgeCommand('echo "" end')).toEqual(["echo", "", "end"])
    expect(splitBridgeCommand('sh -c "a b"')).toEqual(["sh", "-c", "a b"])
  })

  test("validates declared method parameters", async () => {
    const bridges = new SuperskillBridges()
    const skill = parseSuperskill({
      ...sampleSkill(writeEchoScript()),
      methods: [
        { name: "ping", description: "Echo.", parameters: { value: { required: true } } },
      ],
    })
    await expect(bridges.call(skill, "ping", {})).rejects.toThrow("requires")
    await expect(bridges.call(skill, "ping", { value: 1, extra: 2 })).rejects.toThrow("does not declare")
    expect(await bridges.call(skill, "ping", { value: 42 })).toEqual({ value: 42 })
    bridges.close()
  })

  test("an authorization callback can deny a call", async () => {
    const bridges = new SuperskillBridges(() => false)
    const skill = parseSuperskill(sampleSkill(writeEchoScript()))
    await expect(bridges.call(skill, "ping", {})).rejects.toThrow("not authorized")
    bridges.close()
  })

  test("a timed-out child is killed and the next call respawns", async () => {
    const bridges = new SuperskillBridges()
    const skill = parseSuperskill({
      ...sampleSkill(writeEchoScript()),
      bridge: { type: "stdio", command: `python3 ${writeEchoScript()}`, timeoutMs: 150 },
    })
    await expect(bridges.call(skill, "hang", {})).rejects.toThrow("did not answer")
    expect(await bridges.call(skill, "ping", { value: "again" })).toEqual({ value: "again" })
    bridges.close()
  })

  test("an oversized frame without a newline is rejected", async () => {
    const bridges = new SuperskillBridges()
    const skill = parseSuperskill({
      ...sampleSkill(writeEchoScript()),
      bridge: { type: "stdio", command: `python3 ${writeEchoScript()}`, timeoutMs: 5000 },
    })
    await expect(bridges.call(skill, "flood", {})).rejects.toThrow("oversized")
    bridges.close()
  })
})

const CLOSE_STDIN_SCRIPT = `import json
import os
import sys
import time

line = sys.stdin.readline()
request = json.loads(line)
print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": "ready"}), flush=True)
time.sleep(0.1)
os.close(0)
time.sleep(30)
`

describe("superskill bridge transport hardening", () => {
  test("an HTTP bridge speaks JSON-RPC", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const body = (await request.json()) as { id: number; params?: unknown }
        return Response.json({ jsonrpc: "2.0", id: body.id, result: body.params })
      },
    })
    const bridges = new SuperskillBridges()
    try {
      const skill = parseSuperskill({
        id: "http-bridge",
        name: "HTTP bridge",
        description: "Test HTTP bridge.",
        instructions: "",
        bridge: { type: "http", url: `http://127.0.0.1:${server.port}/rpc`, timeoutMs: 5000 },
        methods: [{ name: "ping", description: "Echo." }],
      })
      expect(await bridges.call(skill, "ping", { value: 7 })).toEqual({ value: 7 })
    } finally {
      await server.stop(true)
      bridges.close()
    }
  })

  test("a child that closes stdin rejects instead of crashing the bridge", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-superskill-"))
    const path = join(dir, "close.py")
    write(path, CLOSE_STDIN_SCRIPT)
    const bridges = new SuperskillBridges()
    const skill = parseSuperskill({
      id: "close-bridge",
      name: "Close bridge",
      description: "Closes stdin.",
      instructions: "",
      bridge: { type: "stdio", command: `python3 ${path}`, timeoutMs: 800 },
      methods: [{ name: "ping", description: "Echo." }],
    })
    expect(await bridges.call(skill, "ping", {})).toBe("ready")
    await new Promise((resolve) => setTimeout(resolve, 300))
    // The stdin EPIPE (or, if the runtime does not surface it, the bridge
    // timeout) must reject the call rather than throw an uncaught error.
    await expect(bridges.call(skill, "ping", {})).rejects.toThrow()
    bridges.close()
  })
})

describe("superskill registry durability", () => {
  test("refuses to start from an unreadable file instead of discarding it", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-superskill-"))
    const file = join(dir, "superskills.json")
    write(file, '{"superskills": [{"id": "echo-bridge", "name": "Echo"')

    expect(() => new SuperskillRegistry({ file })).toThrow("superskills.json.corrupt")
    expect(existsSync(file)).toBe(false)
    expect(readFileSync(`${file}.corrupt`, "utf8")).toContain("echo-bridge")
  })

  test("leaves no temp file behind when saving", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-superskill-"))
    const file = join(dir, "superskills.json")
    const registry = new SuperskillRegistry({ file })
    registry.save(sampleSkill("/tmp/echo.py"))
    expect(readdirSync(dir)).toEqual(["superskills.json"])
  })
})
