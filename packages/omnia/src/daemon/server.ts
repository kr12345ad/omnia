import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { randomBytes, timingSafeEqual } from "node:crypto"
import type {
  ActionResult,
  ComputerAction,
  ComputerTarget,
  ElementReference,
} from "../protocol"
import type { HostDriver } from "./host-driver"

export const DAEMON_BODY_LIMIT_BYTES = 256 * 1024
export const DAEMON_REQUEST_TIMEOUT_MS = 30000

export interface DaemonExecuteBody {
  target?: { elementId?: string; observationId?: string } & Record<string, unknown>
  action?: { type?: string; text?: string; key?: string } & Record<string, unknown>
  approve?: boolean
}

export interface DaemonHandle {
  url: string
  token: string
  stop: () => Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > DAEMON_BODY_LIMIT_BYTES) {
        reject(new Error("Request body too large."))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => {
      if (chunks.length === 0) return resolve(undefined)
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch {
        reject(new Error("Request body is not valid JSON."))
      }
    })
    request.on("error", reject)
  })
}

function send(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) })
  response.end(body)
}

function failure(message: string, code: string, retryable: boolean): ActionResult {
  return { success: false, status: "failed", message, error: { code, message, retryable } }
}

function toComputerAction(targetId: string, action: NonNullable<DaemonExecuteBody["action"]>): ComputerAction | undefined {
  const target: ComputerTarget = { kind: "element", elementId: targetId }
  switch (action.type) {
    case "click":
      return { type: "click", target }
    case "doubleclick":
      return { type: "doubleclick", target }
    case "rightclick":
      return { type: "rightclick", target }
    case "focus":
      return { type: "focus", target }
    case "type":
      return typeof action.text === "string" ? { type: "type", target, text: action.text } : undefined
    case "key":
      return typeof action.key === "string" ? { type: "key", target, key: action.key } : undefined
    default:
      return undefined
  }
}

async function executeAction(driver: HostDriver, body: DaemonExecuteBody): Promise<ActionResult> {
  const elementId = typeof body.target?.elementId === "string" ? body.target.elementId : undefined
  const actionType = typeof body.action?.type === "string" ? body.action.type : undefined
  if (!elementId || !actionType) return failure("Execute requires a target elementId and an action type.", "invalid_action", false)
  if (body.approve !== true) {
    return {
      success: false,
      status: "rejected",
      message: "State-changing computer actions require explicit approval.",
      error: { code: "approval_required", message: "State-changing computer actions require explicit approval.", retryable: false },
    }
  }
  const computerAction = toComputerAction(elementId, { type: actionType, text: body.action?.text, key: body.action?.key })
  if (!computerAction) {
    return failure(`Action ${actionType} is not supported by this driver.`, "operation_unavailable", false)
  }
  const reference: ElementReference = {
    kind: "element",
    elementId,
    ...(typeof body.target?.observationId === "string" ? { observationId: body.target.observationId } : {}),
  }
  const revalidation = await driver.revalidateTarget(reference)
  if (!revalidation.valid) {
    return failure(revalidation.reason ?? "The target is stale.", "target_stale", true)
  }
  if (!driver.execute) {
    return failure("The driver does not support executing actions.", "operation_unavailable", false)
  }
  const result = await driver.execute(computerAction)
  if (!result.success) return result
  if (!driver.observe) return result
  const after = await driver.observe().catch(() => undefined)
  return { ...result, ...(after === undefined ? {} : { observation: after }) }
}

export async function startDaemon(driver: HostDriver, token = randomBytes(32).toString("hex")): Promise<DaemonHandle> {
  const server = createServer(async (request, response) => {
    try {
      const header = request.headers.authorization ?? ""
      const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : ""
      const expected = Buffer.from(token)
      const actual = Buffer.from(presented)
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        send(response, 401, { ok: false, error: "Unauthorized." })
        return
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      if (request.method === "GET" && url.pathname === "/v1/info") {
        if (!driver.getInfo) {
          send(response, 500, { ok: false, error: "The driver cannot describe this computer." })
          return
        }
        send(response, 200, { ok: true, info: await driver.getInfo() })
        return
      }
      if (request.method === "GET" && url.pathname === "/v1/capabilities") {
        if (!driver.getInfo) {
          send(response, 500, { ok: false, error: "The driver cannot describe this computer." })
          return
        }
        send(response, 200, { ok: true, capabilities: driver.capabilities ?? [], info: await driver.getInfo() })
        return
      }
      if (request.method === "POST" && url.pathname === "/v1/observe") {
        if (!driver.observe) {
          send(response, 500, { ok: false, error: "The driver cannot observe this computer." })
          return
        }
        const body = (await readBody(request)) as { applicationId?: unknown } | undefined
        const applicationId = typeof body?.applicationId === "string" ? body.applicationId : undefined
        send(response, 200, { ok: true, observation: await driver.observe({ applicationId }) })
        return
      }
      if (request.method === "POST" && url.pathname === "/v1/find") {
        const body = (await readBody(request)) as {
          query?: unknown
          role?: unknown
          name?: unknown
          limit?: unknown
        } | undefined
        if (!body || typeof body.query !== "string" || body.query.length === 0) {
          send(response, 400, { ok: false, error: "Find requires a non-empty query." })
          return
        }
        if (!driver.find) {
          send(response, 500, { ok: false, error: "The driver cannot search this computer." })
          return
        }
        send(
          response,
          200,
          {
            ok: true,
            result: await driver.find({
              query: body.query,
              ...(typeof body.role === "string" ? { role: body.role } : {}),
              ...(typeof body.name === "string" ? { name: body.name } : {}),
              ...(typeof body.limit === "number" ? { limit: body.limit } : {}),
            }),
          },
        )
        return
      }
      if (request.method === "POST" && url.pathname === "/v1/execute") {
        const body = (await readBody(request)) as DaemonExecuteBody | undefined
        if (!body || !isRecord(body)) {
          send(response, 400, { ok: false, error: "Execute requires a JSON body." })
          return
        }
        const result = await executeAction(driver, body)
        send(response, 200, { ok: true, result })
        return
      }
      send(response, 404, { ok: false, error: "Unknown route." })
    } catch (error) {
      send(response, 500, { ok: false, error: error instanceof Error ? error.message : "Daemon request failed." })
    }
  })
  server.timeout = DAEMON_REQUEST_TIMEOUT_MS
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}
