import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("standalone credential publication", () => {
  test("generated bearer is stored privately and never published on stdout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-standalone-"))
    const file = join(dir, "connection.json")
    const processEnv = {
      ...process.env,
      HOME: dir,
      OMNIA_SERVER_HOST: "127.0.0.1",
      OMNIA_SERVER_PORT: "0",
      OMNIA_SERVER_TOKEN: undefined,
      OMNIA_SERVER_INFO_FILE: file,
      OMNIA_AUTH_FILE: join(dir, "auth.json"),
      OMNIA_AUDIT_FILE: join(dir, "audit.jsonl"),
      OMNIA_LOCAL_DRIVER: "0",
      OMNIA_DISCOVERY: "0",
      OMNIA_MODELS_DIR: join(dir, "models"),
      OMNIA_OPENCODE_URL: undefined,
      OMNIA_OPENCODE_PASSWORD: undefined,
    }
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "standalone.ts")], {
      cwd: dir, env: processEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    })
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let output = ""
    const timeout = setTimeout(() => child.kill(), 10_000)
    try {
      while (!output.includes("Omnia server listening")) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error(`Standalone exited before readiness: ${output}`)
        output += decoder.decode(chunk.value, { stream: true })
      }
      const connection = JSON.parse(readFileSync(file, "utf8")) as {
        token: string
        url: string
        grpcUrl?: string
        grpcPort?: number
      }
      expect(connection.token).toMatch(/^[a-f0-9]{64}$/)
      expect(connection.grpcUrl).toMatch(/^grpc:\/\/127\.0\.0\.1:\d+$/)
      expect(connection.grpcPort).toBeGreaterThan(0)
      expect(output).not.toContain(connection.token)
      expect(output).not.toContain('"token"')
      if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600)
      const response = await fetch(`${connection.url}/v1/health`, { headers: { authorization: `Bearer ${connection.token}` } })
      expect(response.status).toBe(200)
    } finally {
      clearTimeout(timeout)
      child.kill()
      await child.exited
      reader.releaseLock()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)
})
