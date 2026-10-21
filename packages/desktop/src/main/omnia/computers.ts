import { existsSync } from "node:fs"
import { join } from "node:path"
import { app, ipcMain } from "electron"
import { serverCall } from "./server-call"
import { enterpriseGuard } from "./enterprise"

function computerPath(computerId: string): string {
  return `/v1/computers/${encodeURIComponent(computerId)}`
}

export function registerComputerIpcHandlers(): void {
  const guarded = (channel: string, listener: Parameters<typeof ipcMain.handle>[1]) =>
    ipcMain.handle(channel, enterpriseGuard("computerUse", "Computer control", listener))
  guarded("computers-list", async () => (await serverCall("/v1/computers", "GET")).computers ?? [])
  guarded("computers-pair-create", async (_event, name?: string) => {
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
  guarded("computers-pair-cancel", async (_event, code: string) => {
    const json = await serverCall(`/v1/computers/pair/${encodeURIComponent(code)}`, "DELETE")
    return json.ok === true
  })
  guarded("computers-stop", async (_event, computerId: string, reason?: string) => {
    const json = await serverCall(`${computerPath(computerId)}/stop`, "POST", {
      ...(reason === undefined ? {} : { reason }),
    })
    return json.result
  })
  guarded("computers-connect", async (_event, computerId: string) => {
    const json = await serverCall(`${computerPath(computerId)}/connect`, "POST", {})
    return json.result
  })
  // Stored sign-ins are a separate switch: an admin can allow computer control
  // without letting the agent spend credentials kept in the vault.
  const guardedCredential = (channel: string, listener: Parameters<typeof ipcMain.handle>[1]) =>
    ipcMain.handle(
      channel,
      enterpriseGuard("credentialVault", "Credential vault", enterpriseGuard("computerUse", "Computer control", listener)),
    )
  guardedCredential("credentials-list", async (_event, computerId: string) => {
    const json = await serverCall(`${computerPath(computerId)}/credentials`, "GET")
    return json.credentials ?? []
  })
  guardedCredential("credentials-save", async (_event, input: { computerId?: string }) => {
    const computerId = input.computerId ?? ""
    const json = await serverCall(`${computerPath(computerId)}/credentials`, "POST", input)
    return json.credential
  })
  guardedCredential("credentials-remove", async (_event, computerId: string, id: string) => {
    const json = await serverCall(`${computerPath(computerId)}/credentials/${encodeURIComponent(id)}`, "DELETE")
    return json.ok === true
  })
}
