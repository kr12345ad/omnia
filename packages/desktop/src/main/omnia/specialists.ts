import { ipcMain } from "electron"
import type { Specialist, SpecialistRoster } from "@opencode-ai/omnia/specialists/types"
import { serverCall } from "./server-call"
import { enterpriseGuard } from "./enterprise"

function roster(json: Record<string, unknown>): SpecialistRoster {
  return {
    entitled: json.entitled === true,
    custom: json.custom === true,
    specialists: Array.isArray(json.specialists) ? json.specialists : [],
    defaults: Array.isArray(json.defaults) ? json.defaults : [],
    limits: json.limits as SpecialistRoster["limits"],
  }
}

export function registerSpecialistIpcHandlers(): void {
  const guarded = (channel: string, listener: Parameters<typeof ipcMain.handle>[1]) =>
    ipcMain.handle(channel, enterpriseGuard("subagents", "Specialists", listener))
  guarded("specialists-get", async () => roster(await serverCall("/v1/specialists", "GET")))
  guarded("specialists-save", async (_event, specialists: Specialist[]) =>
    roster(await serverCall("/v1/specialists", "PUT", { specialists })),
  )
  guarded("specialists-reset", async () => roster(await serverCall("/v1/specialists", "PUT", { reset: true })))
}
