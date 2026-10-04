import { existsSync } from "node:fs"
import { join } from "node:path"
import { app, ipcMain } from "electron"
import { serverCall } from "./server-call"

function computerPath(computerId: string): string {
  return `/v1/computers/${encodeURIComponent(computerId)}`
}

export function registerComputerIpcHandlers(): void {
  ipcMain.handle("computers-list", async () => (await serverCall("/v1/computers", "GET")).computers ?? [])
  ipcMain.handle("computers-pair-create", async (_event, name?: string) => {
    const json = await serverCall("/v1/computers/pair", "POST", {
      ...(name === undefined || name.trim().length === 0 ? {} : { name }),
    })
    const pairing = json.pairing as { code?: unknown; expiresAt?: unknown } | undefined
    const code = pairing?.code
    if (typeof code !== "string") throw new Error("The Omnia Server did not return a pairing code.")
    const serverUrl = typeof json.serverUrl === "string" ? json.serverUrl : ""
    const cliPath = join(app.getAppPath(), "..", "omnia", "src", "remote", "cli.ts")
    return {
      code,
      expiresAt: typeof pairing?.expiresAt === "number" ? pairing.expiresAt : 0,
      serverUrl,
      ...(typeof json.pairingCode === "string" ? { pairingCode: json.pairingCode } : {}),
      ...(existsSync(cliPath) ? { command: `bun ${cliPath} pair --url ${serverUrl} --code ${code}` } : {}),
    }
  })
  ipcMain.handle("computers-pair-cancel", async (_event, code: string) => {
    const json = await serverCall(`/v1/computers/pair/${encodeURIComponent(code)}`, "DELETE")
    return json.ok === true
  })
  ipcMain.handle("computers-stop", async (_event, computerId: string, reason?: string) => {
    const json = await serverCall(`${computerPath(computerId)}/stop`, "POST", {
      ...(reason === undefined ? {} : { reason }),
    })
    return json.result
  })
  ipcMain.handle("computers-connect", async (_event, computerId: string) => {
    const json = await serverCall(`${computerPath(computerId)}/connect`, "POST", {})
    return json.result
  })
  ipcMain.handle("credentials-list", async (_event, computerId: string) => {
    const json = await serverCall(`${computerPath(computerId)}/credentials`, "GET")
    return json.credentials ?? []
  })
  ipcMain.handle("credentials-save", async (_event, input: { computerId?: string }) => {
    const computerId = input.computerId ?? ""
    const json = await serverCall(`${computerPath(computerId)}/credentials`, "POST", input)
    return json.credential
  })
  ipcMain.handle("credentials-remove", async (_event, computerId: string, id: string) => {
    const json = await serverCall(`${computerPath(computerId)}/credentials/${encodeURIComponent(id)}`, "DELETE")
    return json.ok === true
  })
}
