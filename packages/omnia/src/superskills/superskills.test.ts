import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SuperskillRegistry, parseSuperskill } from "./registry"
import { SuperskillBridges, splitBridgeCommand } from "./bridge"

const ECHO_SCRIPT = `import json
import sys

for line in sys.stdin:
    request = json.loads(line)
    if request.get("method") == "fail":
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "error": {"message": "intentional failure"}}), flush=True)
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
