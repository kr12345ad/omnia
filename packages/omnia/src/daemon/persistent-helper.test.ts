import { expect, test } from "bun:test"
import { createJsonLineHelper } from "./persistent-helper"

// Exercise the real JSON-line transport without a desktop session.
function helper(body: string, options: { timeoutMs?: number; maxOutputBytes?: number } = {}) {
  return createJsonLineHelper({ interpreter: "python3", script: body, label: "test helper", ...options })
}

test("a silent helper has a bounded readiness deadline", async () => {
  const child = helper("import time; time.sleep(30)", { timeoutMs: 40 })
  try {
    const ready = await Promise.race([child.ready, new Promise<undefined>((resolve) => setTimeout(resolve, 2000))])
    expect(ready?.ok).toBe(false)
    expect(child.exited).toBe(true)
  } finally { await child.dispose() }
})

test("disposing before readiness settles the readiness promise", async () => {
  const child = helper("import time; time.sleep(30)")
  await child.dispose()
  expect((await child.ready).ok).toBe(false)
})

test("oversized output makes the helper unusable", async () => {
  const child = helper(`import time; print("x" * 1000, flush=True); time.sleep(30)`, { maxOutputBytes: 80, timeoutMs: 300 })
  try {
    const ready = await Promise.race([child.ready, new Promise<undefined>((resolve) => setTimeout(resolve, 500))])
    expect(ready?.ok).toBe(false)
    expect(child.exited).toBe(true)
    await expect(child.request("click")).rejects.toThrow()
  } finally { await child.dispose() }
})

test("a request timeout terminates a helper before subsequent input", async () => {
  const child = helper(`import time; print('{"ready":true,"ok":true}', flush=True); time.sleep(30)`)
  try {
    expect((await child.ready).ok).toBe(true)
    await expect(child.request("click", {}, 30)).rejects.toThrow("timed out")
    expect(child.exited).toBe(true)
    await expect(child.request("type")).rejects.toThrow()
  } finally { await child.dispose() }
})

test("UTF-8 characters survive split stdout chunks", async () => {
  const child = helper(`
import sys, json, time
print('{"ready":true,"ok":true}', flush=True)
request = json.loads(sys.stdin.readline())
payload = json.dumps({"id":request["id"],"ok":True,"text":"日本語"}, ensure_ascii=False).encode()
at = payload.index("日".encode()) + 1
sys.stdout.buffer.write(payload[:at]); sys.stdout.buffer.flush()
time.sleep(0.03)
sys.stdout.buffer.write(payload[at:] + bytes([10])); sys.stdout.buffer.flush()
time.sleep(30)`)
  try {
    await child.ready
    expect((await child.request("read")).payload.text).toBe("日本語")
  } finally { await child.dispose() }
})


test("a synchronous request serialization failure does not retire the helper later", async () => {
  const child = helper(`import json, sys
print(json.dumps({"ready": True, "ok": True}), flush=True)
for line in sys.stdin:
    data = json.loads(line)
    print(json.dumps({"id": data["id"], "ok": True}), flush=True)
`)
  try {
    expect((await child.ready).ok).toBe(true)
    await expect(child.request("invalid", { value: 1n }, 30)).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(child.exited).toBe(false)
    expect((await child.request("ping")).ok).toBe(true)
  } finally { await child.dispose() }
})
