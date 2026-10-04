import type { Plugin } from "@opencode-ai/plugin"
import { chmod, rename, rm, writeFile } from "node:fs/promises"
import { randomInt, randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"

const DEV_DATA_FILE = "/tmp/opencode-workspace-dev-data.json"

async function waitForHealth(port: number) {
  const url = `http://127.0.0.1:${port}/global/health`
  const started = Date.now()

  while (Date.now() - started < 30_000) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }
    } catch {}

    await sleep(250)
  }

  throw new Error(`Timed out waiting for debug server health check at ${url}`)
}

const ports = new Map<string, number>()

async function writeDebugData(port: number, id: string, env: Record<string, string | undefined>) {
  // The payload carries OPENCODE_AUTH_CONTENT, so it must never be readable by
  // other users. Write it through a unique, exclusively-created temp file in the
  // same directory: a fixed name would let a local user pre-create it as a
  // symlink (clobbering whatever it points at) and would let concurrent
  // creations interleave their writes into one file.
  const temp = `${DEV_DATA_FILE}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, JSON.stringify({ port, id, env }, null, 2), { mode: 0o600, flag: "wx" })
    await chmod(temp, 0o600)
    await rename(temp, DEV_DATA_FILE)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

export const DebugWorkspacePlugin: Plugin = async ({ experimental_workspace }) => {
  experimental_workspace.register("debug", {
    name: "Debug",
    description: "Create a debugging server",
    configure(config) {
      return config
    },
    async create(config, env) {
      const port = randomInt(5000, 9001)
      ports.set(config.id, port)

      await writeDebugData(port, config.id, env)

      await waitForHealth(port)
    },
    async remove(config) {
      ports.delete(config.id)
    },
    target(config) {
      const port = ports.get(config.id)
      if (port === undefined) throw new Error(`Debug workspace ${config.id} was never created`)
      return {
        type: "remote",
        url: `http://localhost:${port}/`,
      }
    },
  })

  return {}
}

export default DebugWorkspacePlugin
