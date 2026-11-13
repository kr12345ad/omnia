import { describe, expect, test } from "bun:test"
import {
  FAILURE_CODES,
  FetchTimeoutError,
  classifyFailure,
  createTimeoutFetch,
  describeFailure,
  isMixedContent,
  normalizeServerUrl,
  probeReachability,
  type FetchLike,
} from "./fetch"
import { ChatApi } from "../../../app/src/chat/api"

function ok(input: string) {
  const result = normalizeServerUrl(input)
  if (!result.ok) throw new Error(`expected a normalized URL, got ${result.failure.code}: ${result.failure.detail}`)
  return result
}

function bad(input: string) {
  const result = normalizeServerUrl(input)
  if (result.ok) throw new Error(`expected a failure, got ${result.url}`)
  return result.failure
}

/** Resolves only when the request is aborted, with the abort reason. */
function hangingFetch(): FetchLike {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (!signal) return
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    })
}

function inputUrl(input: string | URL | Request) {
  if (input instanceof URL) return input.href
  return typeof input === "string" ? input : input.url
}

function networkError() {
  return new TypeError("Failed to fetch")
}

describe("normalizeServerUrl", () => {
  test("adds http to a bare host and strips the trailing slash", () => {
    const result = ok(" 192.168.1.20:4096/ ")
    expect(result.url).toBe("http://192.168.1.20:4096")
    expect(result.warnings).toEqual(["insecure_transport"])
  })

  test("keeps https, the deployment prefix, and drops the entry page and token", () => {
    const result = ok("https://omnia.example/test1/omnia/chat.html?auth_token=b3BlbmNvZGU6c2VjcmV0")
    expect(result.url).toBe("https://omnia.example/test1/omnia")
    expect(result.authToken).toBe("b3BlbmNvZGU6c2VjcmV0")
    expect(result.warnings).toEqual([])
  })

  test("strips mobile and index entry pages without eating the prefix", () => {
    expect(ok("https://omnia.example/test1/omnia/mobile").url).toBe("https://omnia.example/test1/omnia")
    expect(ok("https://omnia.example/test1/omnia/mobile.html/").url).toBe("https://omnia.example/test1/omnia")
    expect(ok("https://omnia.example/test1/omnia/index.html").url).toBe("https://omnia.example/test1/omnia")
  })

  test("normalizes scheme and host case and does not warn on loopback", () => {
    expect(ok("HTTPS://OMNIA.EXAMPLE").url).toBe("https://omnia.example")
    expect(ok("localhost:4096").warnings).toEqual([])
    expect(ok("http://127.0.0.1:4096").warnings).toEqual([])
    expect(ok("http://[::1]:4096").warnings).toEqual([])
  })

  test("is idempotent", () => {
    const once = ok("192.168.1.20:4096/test1/chat.html").url
    expect(ok(once).url).toBe(once)
  })

  test("rejects empty, non-http, embedded credentials, and unknown queries", () => {
    expect(bad("").code).toBe("invalid_url")
    expect(bad("   ").code).toBe("invalid_url")
    expect(bad("ftp://host:21").code).toBe("invalid_url")
    expect(bad("file:///etc/passwd").code).toBe("invalid_url")
    expect(bad("https://user:pass@host:4096").code).toBe("invalid_url")
    expect(bad("https://host:4096?server=other").code).toBe("invalid_url")
    expect(bad("https://host:4096?auth_token=x&server=y").code).toBe("invalid_url")
  })
})

describe("isMixedContent", () => {
  test("flags https pages calling a plain-http LAN host but not loopback", () => {
    expect(isMixedContent("https://omnia.example/mobile.html", "http://192.168.1.5:4096")).toBe(true)
    expect(isMixedContent("https://omnia.example/mobile.html", "http://localhost:4096")).toBe(false)
    expect(isMixedContent("http://localhost:5173", "http://192.168.1.5:4096")).toBe(false)
    expect(isMixedContent(undefined, "http://192.168.1.5:4096")).toBe(false)
  })
})

describe("probeReachability", () => {
  test("a resolved response means reachable, even when it is a 401", async () => {
    let request: { url: string; init?: RequestInit } | undefined
    const outcome = await probeReachability({
      baseUrl: "http://192.168.1.5:4096",
      fetch: async (input, init) => {
        request = { url: inputUrl(input), init }
        return new Response(undefined, { status: 401 })
      },
    })

    expect(outcome).toBe("reachable")
    expect(request?.url).toBe("http://192.168.1.5:4096/api/health")
    expect(request?.init?.mode).toBe("no-cors")
    expect(request?.init?.credentials).toBe("omit")
  })

  test("a rejected probe means unreachable", async () => {
    const outcome = await probeReachability({
      baseUrl: "http://192.168.1.5:4096",
      fetch: async () => {
        throw networkError()
      },
    })
    expect(outcome).toBe("unreachable")
  })

  test("fails closed when the runtime refuses no-cors", async () => {
    const outcome = await probeReachability({
      baseUrl: "http://192.168.1.5:4096",
      fetch: (() => {
        throw new TypeError("no-cors mode is not implemented")
      }) as FetchLike,
    })
    expect(outcome).toBe("unreachable")
  })
})

describe("createTimeoutFetch", () => {
  test("abandons a hung request with FetchTimeoutError and classifies it as timeout", async () => {
    const timed = createTimeoutFetch({ fetch: hangingFetch(), timeoutMs: 10 })
    let caught: unknown
    try {
      await timed("http://192.168.1.5:4096/api/location")
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(FetchTimeoutError)
    const failure = classifyFailure({ error: caught, operation: "location" })
    expect(failure.code).toBe("timeout")
    expect(failure.detail).toContain("10ms")
  })

  test("a caller abort is cancelled, not a timeout", async () => {
    const controller = new AbortController()
    const timed = createTimeoutFetch({ fetch: hangingFetch(), timeoutMs: 1_000 })
    const pending = timed("http://192.168.1.5:4096/api/location", { signal: controller.signal })
    controller.abort()

    let caught: unknown
    try {
      await pending
    } catch (error) {
      caught = error
    }

    expect(classifyFailure({ error: caught }).code).toBe("cancelled")
  })

  test("installs a signal on unary requests", async () => {
    let signal: AbortSignal | null | undefined
    const timed = createTimeoutFetch({
      timeoutMs: 1_000,
      fetch: async (_input, init) => {
        signal = init?.signal
        return new Response("{}", { status: 200 })
      },
    })

    await timed("http://host:4096/api/location")
    expect(signal).toBeInstanceOf(AbortSignal)
  })

  test("leaves event streams on the caller's signal", async () => {
    let signal: AbortSignal | null | undefined
    const timed = createTimeoutFetch({
      timeoutMs: 10,
      fetch: async (_input, init) => {
        signal = init?.signal
        return new Response("", { status: 204 })
      },
    })

    await timed("http://host:4096/api/event", { headers: { accept: "text/event-stream" } })
    expect(signal).toBeUndefined()
  })

  test("detects the SSE accept header in a Headers instance", async () => {
    let signal: AbortSignal | null | undefined
    const timed = createTimeoutFetch({
      timeoutMs: 10,
      fetch: async (_input, init) => {
        signal = init?.signal
        return new Response("", { status: 204 })
      },
    })

    await timed("http://host:4096/api/event", { headers: new Headers({ accept: "text/event-stream" }) })
    expect(signal).toBeUndefined()
  })

  test("timeoutMs 0 passes the caller's init through", async () => {
    const controller = new AbortController()
    let signal: AbortSignal | null | undefined
    const timed = createTimeoutFetch({
      timeoutMs: 0,
      fetch: async (_input, init) => {
        signal = init?.signal
        return new Response("", { status: 204 })
      },
    })

    await timed("http://host:4096/api/location", { signal: controller.signal })
    expect(signal).toBe(controller.signal)
  })
})

describe("classifyFailure", () => {
  test("names every documented state with usable copy", () => {
    const codes = new Set<string>(FAILURE_CODES)
    expect(codes.size).toBe(FAILURE_CODES.length)
    for (const code of FAILURE_CODES) {
      const failure = describeFailure(code)
      expect(failure.code).toBe(code)
      expect(failure.title.length).toBeGreaterThan(0)
      expect(failure.detail.length).toBeGreaterThan(0)
      expect(failure.action.length).toBeGreaterThan(0)
      expect(["none", "backoff", "user"]).toContain(failure.retry)
    }
  })

  test("invalid_url", () => {
    expect(classifyFailure({ code: "invalid_url" }).code).toBe("invalid_url")
    expect(bad("not a url at all").code).toBe("invalid_url")
  })

  test("unreachable when neither the request nor the probe connects", () => {
    expect(classifyFailure({ error: networkError(), probe: "unreachable" }).code).toBe("unreachable")
    expect(classifyFailure({ error: networkError() }).code).toBe("unreachable")
    expect(classifyFailure({ error: networkError(), probe: "skipped" }).code).toBe("unreachable")
  })

  test("host_offline when this device paired before and the probe also failed", () => {
    const failure = classifyFailure({ error: networkError(), probe: "unreachable", remembered: true })
    expect(failure.code).toBe("host_offline")
    expect(failure.retry).toBe("backoff")
  })

  test("cors_blocked when only the host's browser policy rejected the request", () => {
    const failure = classifyFailure({ error: networkError(), probe: "reachable" })
    expect(failure.code).toBe("cors_blocked")
    expect(failure.retry).toBe("user")
  })

  test("a reachable probe with no error still cannot be called cors_blocked", () => {
    expect(classifyFailure({ error: networkError() }).code).not.toBe("cors_blocked")
  })

  test("timeout", () => {
    expect(classifyFailure({ error: new FetchTimeoutError(15_000) }).code).toBe("timeout")
    expect(classifyFailure({ error: Object.assign(new Error("slow"), { name: "TimeoutError" }) }).code).toBe("timeout")
  })

  test("tls_error is read from an Electron/Node cause chain", () => {
    const error = new TypeError("fetch failed")
    Object.defineProperty(error, "cause", {
      value: Object.assign(new Error("self signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
    })
    const failure = classifyFailure({ error })
    expect(failure.code).toBe("tls_error")
    expect(failure.detail).toContain("DEPTH_ZERO_SELF_SIGNED_CERT")
  })

  test("unauthorized for 401", () => {
    expect(classifyFailure({ error: { status: 401 }, operation: "location" }).code).toBe("unauthorized")
  })

  test("forbidden for 403 without misreporting it as a wrong password", () => {
    expect(classifyFailure({ error: { status: 403 } }).code).toBe("forbidden")
  })

  test("not_omnia for a missing location endpoint, a non-JSON answer, or a wrong health body", () => {
    expect(classifyFailure({ error: { status: 404 }, operation: "location" }).code).toBe("not_omnia")
    expect(classifyFailure({ error: new SyntaxError("Unexpected token <") }).code).toBe("not_omnia")
    expect(classifyFailure({ health: "not_omnia" }).code).toBe("not_omnia")
  })

  test("incompatible for a method or shape mismatch on a chat endpoint", () => {
    expect(classifyFailure({ error: { status: 405 }, operation: "location" }).code).toBe("incompatible")
    expect(classifyFailure({ error: { status: 422 }, operation: "sessions" }).code).toBe("incompatible")
  })

  test("server_error for 5xx and unnamed failures", () => {
    expect(classifyFailure({ error: { status: 500 } }).code).toBe("server_error")
    expect(classifyFailure({ error: new Error("boom") }).code).toBe("server_error")
  })

  test("session_not_found for a 404 on a session resource", () => {
    expect(classifyFailure({ error: { status: 404 }, operation: "messages" }).code).toBe("session_not_found")
    expect(classifyFailure({ error: { status: 404 }, operation: "prompt" }).code).toBe("session_not_found")
  })

  test("stream_lost when the host answers the probe but the event stream drops", () => {
    const failure = classifyFailure({ error: networkError(), operation: "events", probe: "reachable" })
    expect(failure.code).toBe("stream_lost")
    expect(failure.retry).toBe("backoff")
  })

  test("no_models when the chat-runnable list is empty", () => {
    const failure = classifyFailure({ modelCount: 0 })
    expect(failure.code).toBe("no_models")
    expect(failure.action).toContain("AI SDK")
  })

  test("mixed_content wins before the network error is read", () => {
    const failure = classifyFailure({
      pageUrl: "https://omnia.example/mobile.html",
      targetUrl: "http://192.168.1.5:4096",
      error: networkError(),
    })
    expect(failure.code).toBe("mixed_content")
  })

  test("cancelled for an AbortError", () => {
    expect(classifyFailure({ error: new DOMException("Aborted", "AbortError") }).code).toBe("cancelled")
  })

  test("an explicit code override is honoured for caller-owned states", () => {
    expect(classifyFailure({ code: "stream_lost", detail: "reconnecting" }).detail).toBe("reconnecting")
  })
})

describe("ChatApi integration", () => {
  test("the wrapper is injectable and a real 401 classifies as unauthorized", async () => {
    const api = new ChatApi({
      baseUrl: "http://192.168.1.5:4096",
      headers: { authorization: "Basic b3BlbmNvZGU6d3Jvbmc=" },
      fetch: createTimeoutFetch({
        timeoutMs: 1_000,
        fetch: async () =>
          Response.json({ error: "Authentication required" }, { status: 401, headers: { "content-type": "application/json" } }),
      }),
    })

    let caught: unknown
    try {
      await api.location()
    } catch (error) {
      caught = error
    }

    expect(classifyFailure({ error: caught, operation: "location" }).code).toBe("unauthorized")
  })

  test("a TypeError from ChatApi is classified with the probe, not by message text", async () => {
    const api = new ChatApi({
      baseUrl: "http://192.168.1.5:4096",
      fetch: createTimeoutFetch({
        timeoutMs: 1_000,
        fetch: async () => {
          throw new TypeError("Failed to fetch")
        },
      }),
    })

    let caught: unknown
    try {
      await api.location()
    } catch (error) {
      caught = error
    }

    expect(classifyFailure({ error: caught, probe: "reachable" }).code).toBe("cors_blocked")
  })
})
