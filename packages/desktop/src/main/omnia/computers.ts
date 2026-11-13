import { existsSync } from "node:fs"
import { join } from "node:path"
import { app, ipcMain } from "electron"
import { serverCall } from "./server-call"
import { enterpriseGuard } from "./enterprise"
import { readRegisteredComputerId, rememberComputerDisplayName } from "./remote-agent"

function computerPath(computerId: string): string {
  return `/v1/computers/${encodeURIComponent(computerId)}`
}

// The pairing command is copied into a shell. Quote each value so a URL with
// spaces, "&" or a quote character cannot split the command or its flags.
function shellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
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
      ...(existsSync(cliPath)
        ? {
            command: `bun ${shellArgument(cliPath)} pair${
              serverUrl ? ` --url ${shellArgument(serverUrl)}` : ""
            } --code ${shellArgument(code)}`,
          }
        : {}),
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
  guarded("computers-rename", async (_event, computerId: string, name: string) => {
    const trimmed = typeof name === "string" ? name.trim() : ""
    if (computerId.length === 0 || trimmed.length === 0) throw new Error("A computer name is required.")
    const json = await serverCall(computerPath(computerId), "PATCH", { name: trimmed })
    // Keep the chosen name across restarts for this machine's own registration.
    if (readRegisteredComputerId() === computerId) rememberComputerDisplayName(computerId, trimmed)
    return json.computer
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
