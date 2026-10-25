import { rmSync } from "node:fs"
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { writeTestAuthSession } from "../../../test-support/auth-session"
import { handlers } from "../../../test-support/electron"
import { activateTestUserData, useTestUserData } from "../../../test-support/user-data"
import { forgetEnterpriseProfile } from "./enterprise"

// One Electron substitution serves every main-process suite, so the handlers
// this file registers are read from the shared record and its fake app answers
// with a userData directory this suite owns.
const userData = useTestUserData("omnia-specialists-")

const controlPlane = "https://control.example/omnia"
// The signed-in session is a real file in this suite's userData directory, so
// no module in this process is replaced for later suites.
let session: { url: string; clientToken: string } | undefined

// Other files in this directory replace ./server-call process-wide; restore its
// real delegation so these handlers reach the control-plane client under test.
const controlPlaneModule = await import("./control-plane")
mock.module("./server-call", () => ({ serverCall: controlPlaneModule.controlPlaneCall }))

const specialists = await import("./specialists")
specialists.registerSpecialistIpcHandlers()

type CapturedRequest = { url: string; method: string; body: unknown }
const requests: CapturedRequest[] = []
let responses: Response[] = []
const originalFetch = globalThis.fetch

const defaults = [
  { role: "strategist", name: "Strategist", focus: "Goals." },
  { role: "critic", name: "Critic", focus: "Risks." },
]
const limits = { minCount: 2, maxCount: 6, maxNameLength: 40, maxFocusLength: 800 }
const custom = [
  { role: "lawyer", name: "Lawyer", focus: "Contracts." },
  { role: "designer", name: "Designer", focus: "Interfaces." },
]

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function invoke(channel: string, ...args: unknown[]) {
  return Promise.resolve(handlers.get(channel)!({}, ...args))
}

beforeEach(() => {
  activateTestUserData(userData)
  // The real reader consults this, so no module is replaced for later suites.
  process.env.OMNIA_CONTROL_PLANE_URL = controlPlane
  delete process.env.OMNIA_ENTERPRISE_PROFILE
  forgetEnterpriseProfile()
  requests.length = 0
  responses = []
  session = { url: controlPlane, clientToken: "client-token" }
  writeTestAuthSession(userData, session)
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    })
    return responses.shift() ?? jsonResponse({ ok: true })
  }) as unknown as typeof fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
  delete process.env.OMNIA_CONTROL_PLANE_URL
  delete process.env.OMNIA_TEST_USER_DATA
  rmSync(userData, { force: true, recursive: true })
  mock.restore()
})

describe("specialists IPC handlers", () => {
  test("registers the three channels", () => {
    expect(handlers.has("specialists-get")).toBe(true)
    expect(handlers.has("specialists-save")).toBe(true)
    expect(handlers.has("specialists-reset")).toBe(true)
  })

  test("reads the roster without the envelope", async () => {
    responses = [
      jsonResponse({ ok: true, entitled: false, custom: false, specialists: defaults, defaults, limits }),
    ]
    expect(await invoke("specialists-get")).toEqual({
      entitled: false,
      custom: false,
      specialists: defaults,
      defaults,
      limits,
    })
    expect(requests).toEqual([{ url: `${controlPlane}/v1/specialists`, method: "GET", body: undefined }])
  })

  test("saves a roster with PUT", async () => {
    responses = [jsonResponse({ ok: true, entitled: true, custom: true, specialists: custom, defaults, limits })]
    expect(await invoke("specialists-save", custom)).toMatchObject({ custom: true, specialists: custom })
    expect(requests).toEqual([{ url: `${controlPlane}/v1/specialists`, method: "PUT", body: { specialists: custom } }])
  })

  test("resets with PUT reset", async () => {
    responses = [jsonResponse({ ok: true, entitled: true, custom: false, specialists: defaults, defaults, limits })]
    expect(await invoke("specialists-reset")).toMatchObject({ custom: false, specialists: defaults })
    expect(requests).toEqual([{ url: `${controlPlane}/v1/specialists`, method: "PUT", body: { reset: true } }])
  })

  test("rejects a refused save with the server's message", async () => {
    responses = [
      jsonResponse(
        {
          ok: false,
          error: {
            code: "capability_not_entitled",
            message: "Custom specialists are included in Pro.",
            capability: "custom_specialists",
            plan: "free",
            retryable: false,
          },
        },
        402,
      ),
    ]
    const error = await invoke("specialists-save", custom).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("Custom specialists are included in Pro.")
  })

  test("rejects an invalid roster with the server's message", async () => {
    responses = [jsonResponse({ ok: false, error: "A roster needs at least 2 specialists." }, 400)]
    await expect(invoke("specialists-save", custom.slice(0, 1))).rejects.toThrow(
      "A roster needs at least 2 specialists.",
    )
  })

  test("asks for a session before the user signs in", async () => {
    session = undefined
    writeTestAuthSession(userData, undefined)
    await expect(invoke("specialists-get")).rejects.toThrow("Sign in")
    expect(requests).toHaveLength(0)
  })
})
