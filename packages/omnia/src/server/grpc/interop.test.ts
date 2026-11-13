import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startOmniaServer } from "../server"

// This test deliberately uses the independent OpenConfig gNMIc client rather
// than Omnia's own @grpc/grpc-js bindings. It is skipped when gNMIc is not
// installed; set GNMIC_BIN to a gnmic executable to require it in CI.
const gnmic = process.env.GNMIC_BIN ?? Bun.which("gnmic")

async function run(args: readonly string[]): Promise<string> {
  if (gnmic === null) throw new Error("gNMIc is not installed.")
  const process = Bun.spawn([gnmic, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(`gnmic ${args.join(" ")} failed (${exitCode}):\n${stdout}\n${stderr}`)
  }
  return `${stdout}\n${stderr}`
}

interface LiveClient {
  readonly output: () => string
  readonly waitFor: (predicate: (output: string) => boolean, timeoutMs?: number) => Promise<void>
  readonly write: (line: string) => Promise<void>
  readonly stop: () => Promise<void>
}

function live(args: readonly string[]): LiveClient {
  if (gnmic === null) throw new Error("gNMIc is not installed.")
  const process = Bun.spawn([gnmic, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const decoder = new TextDecoder()
  let output = ""
  let errors = ""
  const pump = async (stream: ReadableStream<Uint8Array>, append: (text: string) => void) => {
    const reader = stream.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      append(decoder.decode(value, { stream: true }))
    }
  }
  const stdout = pump(process.stdout, (text) => {
    output += text
  })
  const stderr = pump(process.stderr, (text) => {
    errors += text
  })
  return {
    output: () => output,
    waitFor: async (predicate, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs
      while (!predicate(output)) {
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for gNMIc output.\nstdout:\n${output}\nstderr:\n${errors}`)
        }
        await Bun.sleep(25)
      }
    },
    write: async (line) => {
      process.stdin.write(line)
      await process.stdin.flush()
    },
    stop: async () => {
      process.kill()
      await process.exited.catch(() => undefined)
      await Promise.all([stdout, stderr])
    },
  }
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

async function withServer(fn: (target: string, token: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "omnia-gnmi-interop-"))
  const server = await startOmniaServer({
    grpc: { enabled: true },
    authFile: join(dir, "auth.json"),
    auditFile: join(dir, "audit.jsonl"),
  })
  try {
    await fn(`127.0.0.1:${server.grpc!.port}`, server.token)
  } finally {
    await server.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}

const metadata = (token: string) => ["-H", `authorization=Bearer ${token}`]

if (gnmic === null) {
  test.skip("gNMIc interoperability (install gNMIc or set GNMIC_BIN)", () => {})
} else {
  test("gNMIc interoperates with Capabilities, Get, Set and ONCE Subscribe", async () => {
    await withServer(async (target, token) => {
      const capabilities = await run(["-a", target, "--insecure", ...metadata(token), "capabilities"])
      expect(capabilities).toContain("gNMI version: 0.10.0")
      expect(capabilities).toContain("omnia, Omnia, 0.1.0")
      expect(capabilities).toContain("JSON_IETF")

      const get = await run([
        "-a",
        target,
        "--insecure",
        ...metadata(token),
        "-e",
        "json_ietf",
        "get",
        "--path",
        "/omnia/server/status",
      ])
      expect(get).toContain('"state": "ready"')

      const set = await run([
        "-a",
        target,
        "--insecure",
        ...metadata(token),
        "-e",
        "json_ietf",
        "set",
        "--update-path",
        "/omnia/config/permissions/scope[name=SECRETS]/state",
        "--update-value",
        "granted",
      ])
      expect(set).toContain('"operation": "UPDATE"')

      const subscribe = await run([
        "-a",
        target,
        "--insecure",
        ...metadata(token),
        "-e",
        "json_ietf",
        "subscribe",
        "--path",
        "/omnia/server/status",
        "--mode",
        "once",
      ])
      expect(subscribe).toContain('"state": "ready"')
      expect(subscribe).toContain('"sync-response": true')
    })
  })

  test("gNMIc STREAM ON_CHANGE receives updates from the EventBus", async () => {
    await withServer(async (target, token) => {
      const stream = live([
        "-a",
        target,
        "--insecure",
        ...metadata(token),
        "-e",
        "json_ietf",
        "subscribe",
        "--path",
        "/omnia/config/permissions/scope[name=SECRETS]/state",
        "--mode",
        "stream",
        "--stream-mode",
        "on-change",
      ])
      try {
        await stream.waitFor((output) => output.includes('"sync-response": true'))
        await run([
          "-a",
          target,
          "--insecure",
          ...metadata(token),
          "-e",
          "json_ietf",
          "set",
          "--update-path",
          "/omnia/config/permissions/scope[name=SECRETS]/state",
          "--update-value",
          "denied",
        ])
        await stream.waitFor((output) => output.includes('"denied"'))
      } finally {
        await stream.stop()
      }
    })
  })

  test("gNMIc POLL answers each poll request with a fresh snapshot", async () => {
    await withServer(async (target, token) => {
      const poll = live([
        "-a",
        target,
        "--insecure",
        ...metadata(token),
        "-e",
        "json_ietf",
        "subscribe",
        "--path",
        "/omnia/server/status",
        "--mode",
        "poll",
      ])
      try {
        await poll.waitFor((output) => output.includes('"sync-response": true'))
        const initial = count(poll.output(), '"state": "ready"')
        // gNMIc's interactive poll mode first selects the target, then the
        // subscription. Send an Enter until a new snapshot arrives.
        for (let attempt = 0; attempt < 8; attempt += 1) {
          if (count(poll.output(), '"state": "ready"') > initial) break
          await poll.write("\n")
          await Bun.sleep(200)
        }
        await poll.waitFor((output) => count(output, '"state": "ready"') > initial)
      } finally {
        await poll.stop()
      }
    })
  })

  test("gNMIc connects over TLS with a verified server certificate", async () => {
    const openssl = Bun.which("openssl")
    if (openssl === null) return
    const dir = mkdtempSync(join(tmpdir(), "omnia-gnmi-tls-"))
    const key = join(dir, "key.pem")
    const cert = join(dir, "cert.pem")
    const generated = Bun.spawnSync([
      openssl,
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ])
    if (generated.exitCode !== 0) {
      throw new Error(`openssl could not generate a test certificate: ${generated.stderr.toString()}`)
    }
    const server = await startOmniaServer({
      grpc: {
        enabled: true,
        tls: { cert: await Bun.file(cert).text(), key: await Bun.file(key).text() },
      },
      authFile: join(dir, "auth.json"),
      auditFile: join(dir, "audit.jsonl"),
    })
    try {
      expect(server.grpc?.url.startsWith("grpcs://")).toBe(true)
      const output = await run([
        "-a",
        `127.0.0.1:${server.grpc!.port}`,
        "--tls-ca",
        cert,
        ...metadata(server.token),
        "capabilities",
      ])
      expect(output).toContain("gNMI version: 0.10.0")
    } finally {
      await server.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("gNMIc SAMPLE produces periodic updates", async () => {
    await withServer(async (target, token) => {
      const sample = live([
        "-a",
        target,
        "--insecure",
        ...metadata(token),
        "-e",
        "json_ietf",
        "subscribe",
        "--path",
        "/omnia/server/status",
        "--mode",
        "stream",
        "--stream-mode",
        "sample",
        "-i",
        "200ms",
      ])
      try {
        await sample.waitFor((output) => output.includes('"sync-response": true'))
        const initial = count(sample.output(), '"uptime-ms"')
        await sample.waitFor((output) => count(output, '"uptime-ms"') > initial)
      } finally {
        await sample.stop()
      }
    })
  })
}
