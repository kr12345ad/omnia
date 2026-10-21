import { ipcMain } from "electron"
import type { ScheduledRun } from "@opencode-ai/omnia/agent-run/store"
import { serverCall } from "./server-call"
import { enterpriseGuard } from "./enterprise"

export type HeadlessRun = Pick<
  ScheduledRun,
  "id" | "name" | "prompt" | "intervalMinutes" | "enabled" | "createdAt" | "updatedAt" | "lastFiredAt" | "lastResult"
>

function runs(json: Record<string, unknown>): HeadlessRun[] {
  return Array.isArray(json.runs) ? (json.runs as HeadlessRun[]) : []
}

export function registerRunIpcHandlers(): void {
  const guarded = (channel: string, listener: Parameters<typeof ipcMain.handle>[1]) =>
    ipcMain.handle(channel, enterpriseGuard("scheduledRuns", "Scheduled runs", listener))
  guarded("runs-list", async () => runs(await serverCall("/v1/runs", "GET")))
  guarded("runs-create", async (_event, input: { name: string; prompt: string; intervalMinutes: number }) =>
    (await serverCall("/v1/runs", "POST", input)).run as HeadlessRun,
  )
  guarded(
    "runs-update",
    async (_event, id: string, patch: Partial<Pick<HeadlessRun, "name" | "prompt" | "intervalMinutes" | "enabled">>) =>
      (await serverCall(`/v1/runs/${encodeURIComponent(id)}`, "PATCH", patch)).run as HeadlessRun,
  )
  guarded(
    "runs-remove",
    async (_event, id: string) => (await serverCall(`/v1/runs/${encodeURIComponent(id)}`, "DELETE")).removed === id,
  )
  guarded("runs-once", async (_event, input: { prompt: string; title?: string; timeoutMs?: number }) =>
    serverCall("/v1/runs/once", "POST", input),
  )
}
