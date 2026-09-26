import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"

export interface OmniaServerConfig {
  url: string
  token: string
  computerId?: string
}

export function configFromEnv(): Effect.Effect<OmniaServerConfig> {
  const url = process.env.OMNIA_SERVER_URL
  const token = process.env.OMNIA_SERVER_TOKEN
  if (!url || !token) {
    throw new Error(
      "Computer control is unavailable: the Omnia Server is not running. " +
        "Open Omnia Desktop on this computer so the server starts, then retry.",
    )
  }
  return Effect.succeed({
    url,
    token,
    ...(process.env.OMNIA_COMPUTER_ID === undefined ? {} : { computerId: process.env.OMNIA_COMPUTER_ID }),
  })
}

const LONG_PATHS = ["/do", "/text"]

export function request<Response>(
  http: HttpClient.HttpClient,
  config: OmniaServerConfig,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Effect.Effect<Response> {
  const timeoutMs = LONG_PATHS.some((suffix) => path.endsWith(suffix)) ? 600000 : 120000
  return Effect.gen(function* () {
    const base = HttpClientRequest.make(method)(`${config.url}${path}`).pipe(
      HttpClientRequest.bearerToken(config.token),
      HttpClientRequest.acceptJson,
    )
    const request = body === undefined ? base : HttpClientRequest.bodyJsonUnsafe(base, body)
    const response = yield* http.execute(request).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.die(new Error(`Omnia Server request timed out after ${Math.round(timeoutMs / 1000)}s.`)),
      }),
      Effect.catch(() => Effect.die(new Error("Omnia Server request failed."))),
    )
    const json = (yield* response.json.pipe(
      Effect.catch(() => Effect.die(new Error("Omnia Server returned invalid JSON."))),
    )) as { ok?: unknown; error?: unknown; result?: unknown } & Record<string, unknown>
    if (json.ok !== true) {
      throw new Error(describeFailure(json, response.status))
    }
    return json as Response
  })
}

function describeFailure(json: { error?: unknown; result?: unknown }, status: number): string {
  if (typeof json.error === "string" && json.error.length > 0) return json.error
  const result = json.result
  if (typeof result === "object" && result !== null) {
    const error = (result as { error?: unknown }).error
    if (typeof error === "object" && error !== null) {
      const message = (error as { message?: unknown }).message
      const code = (error as { code?: unknown }).code
      if (typeof message === "string" && message.length > 0) {
        return typeof code === "string" && code.length > 0 ? `${message} [${code}]` : message
      }
    }
    const message = (result as { message?: unknown }).message
    if (typeof message === "string" && message.length > 0) return message
  }
  return `Omnia Server reported failure (HTTP ${status}).`
}

export function computerId(
  http: HttpClient.HttpClient,
  config: OmniaServerConfig,
): Effect.Effect<string> {
  if (config.computerId !== undefined && config.computerId.length > 0) return Effect.succeed(config.computerId)
  return Effect.gen(function* () {
    const response = yield* request<{ ok: true; computers: Array<{ id?: string; connected?: boolean }> }>(
      http,
      config,
      "GET",
      "/v1/computers",
    )
    const connected = response.computers.find((computer) => computer.connected !== false && typeof computer.id === "string")
    const id = connected?.id ?? response.computers.find((computer) => typeof computer.id === "string")?.id
    if (id === undefined) throw new Error("No computer is connected to the Omnia Server.")
    return id
  })
}
