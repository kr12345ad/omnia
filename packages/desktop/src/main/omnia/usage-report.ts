// What a shipped client tells its control plane about the work it did.
//
// The tenant server has always accepted these events (`POST
// /v1/enterprise/public/client/:slug/usage`); until now nothing sent them, so
// every usage chart, per-person total and monthly ceiling in the console had no
// data behind it. This is the wiring: the outbox in `usage-outbox.ts` owns
// dedupe and retries, and this file supplies the endpoint, the credential and
// the admin's telemetry answer.

import { join } from "node:path"
import { app, ipcMain } from "electron"
import { enterprisePolicy, enterpriseProfile } from "./enterprise"
import { readAuthSession } from "./auth-session"
import { createUsageOutbox, type UsageEvent } from "./usage-outbox"

const BATCH_SIZE = 100
const REQUEST_TIMEOUT_MS = 20_000

function outbox() {
  return createUsageOutbox({
    file: join(app.getPath("userData"), "enterprise-usage.json"),
    batchSize: BATCH_SIZE,
    // The manifest can turn telemetry off after a build was installed, so the
    // answer is the live policy rather than the installer's baked profile.
    allowed: async () => {
      if (enterpriseProfile() === undefined) return false
      const policy = await enterprisePolicy().catch(() => undefined)
      return policy !== undefined && policy.telemetry.enabled !== false
    },
    send: async (events) => {
      const profile = enterpriseProfile()
      const session = readAuthSession()
      if (profile === undefined || session === undefined) return false
      try {
        const response = await fetch(
          `${profile.server}/v1/enterprise/public/client/${encodeURIComponent(profile.distribution)}/usage`,
          {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${session.clientToken}` },
            body: JSON.stringify({ events: events.map(stripKey) }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          },
        )
        return response.ok
      } catch {
        return false
      }
    },
  })
}

/** The dedupe key is the client's business, not the server's. */
function stripKey(event: UsageEvent): Omit<UsageEvent, "key"> {
  const { key: _key, ...rest } = event
  return rest
}

let instance: ReturnType<typeof outbox> | undefined

function current(): ReturnType<typeof outbox> {
  instance ??= outbox()
  return instance
}

/**
 * Queue one turn for the control plane.
 *
 * Returns `{ queued: false }` outside a managed build and for a turn already
 * reported, which is the ordinary answer rather than an error: the renderer is
 * allowed to be enthusiastic because this side remembers.
 */
export function reportEnterpriseUsage(input: unknown): { queued: boolean; pending: number } {
  if (enterpriseProfile() === undefined) return { queued: false, pending: 0 }
  const result = current().report(input)
  if (result.queued) void current().flush()
  return result
}

/** Push what is queued. Never throws: the outbox is the error path. */
export function flushEnterpriseUsage(): Promise<void> {
  return current().flush()
}

export function registerUsageReportIpcHandlers(): void {
  ipcMain.handle("omnia-enterprise-report-usage", (_event, input: unknown) => reportEnterpriseUsage(input))
}

// A turn that finished just before the window closed still gets reported.
app.on("before-quit", () => {
  void flushEnterpriseUsage()
})
