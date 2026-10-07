import { ipcMain } from "electron"
import type { Specialist, SpecialistRoster } from "@opencode-ai/omnia/specialists/types"
import { serverCall } from "./server-call"

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
  ipcMain.handle("specialists-get", async () => roster(await serverCall("/v1/specialists", "GET")))
  ipcMain.handle("specialists-save", async (_event, specialists: Specialist[]) =>
    roster(await serverCall("/v1/specialists", "PUT", { specialists })),
  )
  ipcMain.handle("specialists-reset", async () => roster(await serverCall("/v1/specialists", "PUT", { reset: true })))
}
