import { spawnSync } from "node:child_process"
import { Browser, Daemon, Server } from "@opencode-ai/omnia"
import { registerOmniaDriver } from "./registry"
import type { OmniaDriver, OmniaResult, OmniaTargetReference } from "./types"

export interface LocalOmniaServer {
  url: string
  token: string
  serverId: string
  stop: () => Promise<void>
}

function toBridgeDriver(driver: Daemon.HostDriver): OmniaDriver {
  return {
    id: driver.id,
    backend: driver.backend,
    get capabilities() {
      return driver.capabilities
    },
    getInfo: driver.getInfo,
    observe: driver.observe,
    find: driver.find,
    execute: driver.execute,
    revalidateTarget: async (target: OmniaTargetReference): Promise<OmniaResult<OmniaTargetReference>> => {
      const result = await driver.revalidateTarget({
        kind: "element",
        elementId: target.elementId,
        ...(target.observationId === undefined ? {} : { observationId: target.observationId }),
        ...(target.generation === undefined ? {} : { generation: target.generation }),
      })
      if (!result.valid) return { ok: false, status: "blocked", reason: "target_stale" }
      return { ok: true, status: "ok", value: target }
    },
  }
}

function toServerDriver(driver: Daemon.HostDriver): Server.ServerComputerDriver {
  return {
    id: driver.id,
    backend: driver.backend,
    getInfo: () => driver.getInfo(),
    capabilities: () => driver.capabilities ?? [],
    observe: (request) => driver.observe(request),
    find: (request) => driver.find(request),
    execute: (action) => driver.execute(action),
    readText: (input) => driver.readText!(input),
    readClipboard: () => driver.readClipboard!(),
    writeClipboard: (text) => driver.writeClipboard!(text),
    pointerPosition: () => driver.pointerPosition!(),
    hoverPointer: (x, y, holdMs) => driver.hoverPointer!(x, y, holdMs),
    mouseDown: (button) => driver.mouseDown!(button),
    mouseUp: (button) => driver.mouseUp!(button),
    releaseStuckKeys: () => driver.releaseStuckKeys!(),
    revalidateTarget: (reference) => driver.revalidateTarget(reference),
  }
}

interface ModelCatalogEntry {
  id: string
  name?: string
  provider?: string
  capabilities: Record<string, boolean | number>
}

export async function registerModelsWithOmniaServer(
  server: Pick<LocalOmniaServer, "url" | "token">,
  sidecar: { url: string; username?: string; password?: string },
): Promise<number> {
  const authorization =
    sidecar.username === undefined
      ? undefined
      : `Basic ${Buffer.from(`${sidecar.username}:${sidecar.password ?? ""}`).toString("base64")}`
  const response = await fetch(`${sidecar.url}/provider`, {
    headers: authorization === undefined ? {} : { authorization },
  })
  if (!response.ok) throw new Error(`Provider list failed with HTTP ${response.status}.`)
  const body = (await response.json()) as {
    all?: Array<{ id?: string; models?: Record<string, { id?: string; name?: string; capabilities?: { toolcall?: boolean; reasoning?: boolean; attachment?: boolean }; limit?: { context?: number } }> }>
  }
  const models: ModelCatalogEntry[] = []
  for (const provider of body.all ?? []) {
    if (typeof provider.id !== "string") continue
    for (const model of Object.values(provider.models ?? {})) {
      if (typeof model.id !== "string") continue
      models.push({
        id: `${provider.id}/${model.id}`,
        ...(typeof model.name === "string" ? { name: model.name } : {}),
        provider: provider.id,
        capabilities: {
          tools: model.capabilities?.toolcall ?? true,
          reasoning: model.capabilities?.reasoning ?? false,
          vision: model.capabilities?.attachment ?? false,
          context: model.limit?.context ?? 0,
        },
      })
      if (models.length >= 500) break
    }
    if (models.length >= 500) break
  }
  const registered = await fetch(`${server.url}/v1/models`, {
    method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    body: JSON.stringify({ models }),
  })
  if (!registered.ok) throw new Error(`Model registration failed with HTTP ${registered.status}.`)
  return models.length
}

// Flatpak sandboxes LibreOffice away from the accessibility bus, which hides
// its entire UI tree. Grant the narrow a11y bus permission once so the runtime
// can see the app's controls.
export function ensureFlatpakAccessibility(): void {
  const info = spawnSync("flatpak", ["info", "org.libreoffice.LibreOffice"], { stdio: "ignore" })
  if (info.status !== 0) return
  const permissions = spawnSync("flatpak", ["info", "--show-permissions", "org.libreoffice.LibreOffice"], {
    encoding: "utf8",
  })
  if (permissions.stdout?.includes("org.a11y.Bus=talk")) return
  spawnSync(
    "flatpak",
    ["override", "--user", "--talk-name=org.a11y.Bus", "--env=NO_AT_BRIDGE=0", "org.libreoffice.LibreOffice"],
    { stdio: "ignore" },
  )
}

export async function startLocalOmniaServer(): Promise<LocalOmniaServer | undefined> {
  ensureFlatpakAccessibility()
  const host = new Daemon.LinuxHostDriver()
  if (!host.available) return undefined
  const driver = Daemon.createHostDriver(host)
  const browser = new Browser.BrowserRuntime({
    log: (message, meta) => console.log(`[omnia-browser] ${message}`, meta ?? ""),
  })
  const handle = await Server.startOmniaServer({
    drivers: [toServerDriver(driver)],
    browser,
  })
  registerOmniaDriver(toBridgeDriver(driver))
  process.env.OMNIA_SERVER_URL = handle.url
  process.env.OMNIA_SERVER_TOKEN = handle.token
  process.env.OMNIA_COMPUTER_ID = driver.id
  return {
    url: handle.url,
    token: handle.token,
    serverId: handle.serverId,
    stop: async () => {
      await browser.closeRuntime().catch(() => undefined)
      await handle.stop()
    },
  }
}
