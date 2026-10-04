import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventBus } from "./events"
import { PermissionManager, type PermissionState } from "./permissions"
import { ComputerManager, type BrowserController, type ServerComputerDriver } from "./computers"
import { CredentialStore } from "../credentials"
import type { ActionResult, ComputerAction, Observation } from "../protocol"

const SECRET = "hunter2-do-not-leak"
const USERNAME = "krishna"

function errorCode(error: ActionResult["error"]): string | undefined {
  return typeof error === "object" && error !== null ? error.code : error
}

function typedText(action: ComputerAction | undefined): string | undefined {
  return action?.type === "type" ? action.text : undefined
}

function baseDriver(overrides: Partial<ServerComputerDriver> = {}): {
  driver: ServerComputerDriver
  actions: ComputerAction[]
} {
  const actions: ComputerAction[] = []
  const driver: ServerComputerDriver = {
    id: "local",
    backend: "test",
    getInfo: async () => ({ id: "local", name: "Test Computer", platform: "linux", connected: true }),
    capabilities: () => [],
    observe: async (): Promise<Observation> => ({ id: "obs-1", elements: [] }),
    find: async (request) => ({ query: request.query, matches: [] }),
    execute: async (action): Promise<ActionResult> => {
      actions.push(action)
      return { success: true, status: "success", message: `Executed ${action.type}.` }
    },
  }
  return { driver: Object.assign(driver, overrides), actions }
}

function browserHarness(): { browser: BrowserController; typed: Array<{ id: string; text: string }> } {
  const typed: Array<{ id: string; text: string }> = []
  const browser: BrowserController = {
    status: async () => ({ running: true, browser: "test", tabs: 1 }),
    open: async (url) => ({ id: "tab-1", url: url ?? "about:blank" }),
    tabs: async () => [{ id: "tab-1", url: "https://example.com" }],
    activate: async () => undefined,
    closeTab: async () => undefined,
    navigate: async (url) => ({ id: "tab-1", url }),
    read: async () => ({ url: "https://example.com", title: "Login", text: "login form", length: 10, hash: "hash-1" }),
    find: async () => [],
    click: async () => ({ clicked: true }),
    type: async (target) => {
      typed.push({ id: target.id, text: target.text })
      return { typed: true }
    },
    readValue: async (target) => {
      const entry = [...typed].reverse().find((item) => item.id === target.id)
      if (entry === undefined) return {}
      return entry.text === SECRET ? { sensitive: true } : { value: entry.text }
    },
    key: async () => undefined,
    back: async () => undefined,
    forward: async () => undefined,
    reload: async () => undefined,
  }
  return { browser, typed }
}

function createManager(
  driver: ServerComputerDriver,
  options: {
    browser?: BrowserController
    policy?: "fully_autonomous" | "always_ask"
    secrets?: PermissionState
  } = {},
): { manager: ComputerManager; events: EventBus; credentials: CredentialStore } {
  const events = new EventBus({ serverId: "test" })
  // Operator policy for this harness: secrets access is turned on, so an
  // approval that names SECRETS counts. A denied scope needs a per-scope grant
  // or a fingerprint-bound approval instead; the tests that keep SECRETS denied
  // say so explicitly, and computer-command.test.ts covers that floor over HTTP.
  const permissions = new PermissionManager({ SECRETS: options.secrets ?? "prompt" }, options.policy ?? "fully_autonomous")
  const credentials = new CredentialStore({ file: join(mkdtempSync(join(tmpdir(), "omnia-cred-")), "credentials.json") })
  const manager = new ComputerManager({
    events,
    permissions,
    credentials,
    ...(options.browser === undefined ? {} : { browser: options.browser }),
  })
  manager.register(driver)
  return { manager, events, credentials }
}

const approval = {
  approve: true,
  approvedBy: "session:test",
  sessionId: "session-1",
  approvedScopes: ["UI_CONTROL", "KEYBOARD", "SECRETS"] as const,
}

describe("stored credentials on the type action", () => {
  test("an explicit credential types the secret without echoing it", async () => {
    const { driver, actions } = baseDriver()
    const { manager, credentials } = createManager(driver)
    const credential = credentials.save({ computerId: "local", name: "login", secret: SECRET, username: USERNAME })
    const outcome = await manager.execute("local", {
      action: "type",
      target: { elementId: "el-1" },
      credential: credential.id,
      approvedScopes: [...approval.approvedScopes],
      approve: true,
      approvedBy: approval.approvedBy,
      sessionId: approval.sessionId,
    })
    expect(outcome.result.success).toBe(true)
    expect(actions[0]?.type).toBe("type")
    expect(typedText(actions[0])).toBe(SECRET)
    expect(outcome.result.verification?.status).toBe("unverified")
    expect(JSON.stringify(outcome.result)).not.toContain(SECRET)
    expect(JSON.stringify(outcome.result)).not.toContain(USERNAME)
  })

  test("field username types the stored username instead of the secret", async () => {
    const { driver, actions } = baseDriver()
    const { manager, credentials } = createManager(driver)
    const credential = credentials.save({ computerId: "local", name: "login", secret: SECRET, username: USERNAME })
    const outcome = await manager.execute("local", {
      action: "type",
      target: { elementId: "el-1" },
      credential: credential.name,
      field: "username",
      approve: true,
      approvedBy: approval.approvedBy,
      approvedScopes: [...approval.approvedScopes],
      sessionId: approval.sessionId,
    })
    expect(outcome.result.success).toBe(true)
    expect(typedText(actions[0])).toBe(USERNAME)
  })

  test("auto selects the credential whose application rule matches", async () => {
    const { driver, actions } = baseDriver()
    const { manager, credentials } = createManager(driver)
    credentials.save({
      computerId: "local",
      name: "login",
      secret: SECRET,
      rules: [{ kind: "application", match: "LoginApp" }],
    })
    const outcome = await manager.execute("local", {
      action: "type",
      target: { elementId: "el-1" },
      app: "LoginApp",
      credential: "auto",
      approve: true,
      approvedBy: approval.approvedBy,
      approvedScopes: [...approval.approvedScopes],
      sessionId: approval.sessionId,
    })
    expect(outcome.result.success).toBe(true)
    expect(typedText(actions[0])).toBe(SECRET)
  })

  test("a credential stored for another computer is rejected", async () => {
    const { driver } = baseDriver()
    const { manager, credentials } = createManager(driver)
    const credential = credentials.save({ computerId: "other", name: "login", secret: SECRET })
    const outcome = await manager.execute("local", {
      action: "type",
      target: { elementId: "el-1" },
      credential: credential.id,
      approve: true,
      approvedBy: approval.approvedBy,
      approvedScopes: [...approval.approvedScopes],
      sessionId: approval.sessionId,
    })
    expect(outcome.httpStatus).toBe(403)
    expect(errorCode(outcome.result.error)).toBe("credential_not_found")
  })

  test("typing a credential without SECRETS approval is denied", async () => {
    const { driver, actions } = baseDriver()
    const { manager, credentials } = createManager(driver, { policy: "always_ask", secrets: "denied" })
    const credential = credentials.save({ computerId: "local", name: "login", secret: SECRET })
    const outcome = await manager.execute("local", {
      action: "type",
      target: { elementId: "el-1" },
      credential: credential.id,
      approve: true,
      approvedBy: approval.approvedBy,
      approvedScopes: ["UI_CONTROL", "KEYBOARD"],
      sessionId: approval.sessionId,
    })
    expect(outcome.httpStatus).toBe(403)
    expect(errorCode(outcome.result.error)).toBe("permission_denied")
    expect(actions).toHaveLength(0)
  })

  test("an unknown credential field is rejected before typing", async () => {
    const { driver, actions } = baseDriver()
    const { manager, credentials } = createManager(driver)
    const credential = credentials.save({ computerId: "local", name: "login", secret: SECRET })
    const outcome = await manager.execute("local", {
      action: "type",
      target: { elementId: "el-1" },
      credential: credential.id,
      field: "token",
      approve: true,
      approvedBy: approval.approvedBy,
      approvedScopes: [...approval.approvedScopes],
      sessionId: approval.sessionId,
    })
    expect(outcome.httpStatus).toBe(400)
    expect(errorCode(outcome.result.error)).toBe("invalid_action")
    expect(actions).toHaveLength(0)
  })
})

describe("stored credentials on browser_type", () => {
  test("the computer driver's browser wins over the server-global controller", async () => {
    const local = browserHarness()
    const global = browserHarness()
    const { driver } = baseDriver({ browser: local.browser })
    const { manager, credentials } = createManager(driver, { browser: global.browser })
    const credential = credentials.save({ computerId: "local", name: "login", secret: SECRET })
    const outcome = await manager.execute("local", {
      action: "browser_type",
      target: { elementId: "field-1" },
      credential: credential.id,
      approve: true,
      approvedBy: approval.approvedBy,
      approvedScopes: ["BROWSER", "SECRETS"],
      sessionId: approval.sessionId,
    })
    expect(outcome.result.success).toBe(true)
    expect(local.typed).toEqual([{ id: "field-1", text: SECRET }])
    expect(global.typed).toHaveLength(0)
    expect(JSON.stringify(outcome.result)).not.toContain(SECRET)
  })

  test("field username types the stored username on the page", async () => {
    const local = browserHarness()
    const { driver } = baseDriver({ browser: local.browser })
    const { manager, credentials } = createManager(driver)
    const credential = credentials.save({ computerId: "local", name: "login", secret: SECRET, username: USERNAME })
    const outcome = await manager.execute("local", {
      action: "browser_type",
      target: { elementId: "field-1" },
      credential: credential.id,
      field: "username",
      approve: true,
      approvedBy: approval.approvedBy,
      approvedScopes: ["BROWSER", "SECRETS"],
      sessionId: approval.sessionId,
    })
    expect(outcome.result.success).toBe(true)
    expect(local.typed).toEqual([{ id: "field-1", text: USERNAME }])
  })

  test("browser typing a credential without SECRETS approval is denied", async () => {
    const local = browserHarness()
    const { driver } = baseDriver({ browser: local.browser })
    const { manager, credentials } = createManager(driver, { policy: "always_ask", secrets: "denied" })
    const credential = credentials.save({ computerId: "local", name: "login", secret: SECRET })
    const outcome = await manager.execute("local", {
      action: "browser_type",
      target: { elementId: "field-1" },
      credential: credential.id,
      approve: true,
      approvedBy: approval.approvedBy,
      approvedScopes: ["BROWSER"],
      sessionId: approval.sessionId,
    })
    expect(outcome.httpStatus).toBe(403)
    expect(errorCode(outcome.result.error)).toBe("permission_denied")
    expect(local.typed).toHaveLength(0)
  })
})

describe("browser_login with a stored credential", () => {
  // A login form whose password field disappears once the form is submitted,
  // which is what a real sign-in does. keepForm models a rejected login that
  // re-renders the same form.
  function loginHarness(
    fields: Record<string, string>,
    submitLabel?: string,
    options: { keepForm?: boolean } = {},
  ) {
    const typed: Array<{ id: string; text: string }> = []
    const clicked: string[] = []
    let submitted = false
    // Submitting a real login form removes the password field; a rejected
    // login re-renders it, which keepForm models.
    const gone = () => (submitted && options.keepForm !== true ? ["field-pass"] : [])
    const browser: BrowserController = {
      ...browserHarness().browser,
      find: async (query, findOptions) => {
        const role = findOptions?.role
        return Object.entries(fields)
          .filter(([, name]) => name.toLowerCase().includes(query.toLowerCase()))
          .filter(([id]) => !gone().includes(id))
          .map(([id, name]) => ({ id, role: role ?? "textbox", name, score: 1 }))
      },
      read: async () => ({
        url: submitted ? "https://example.com/account" : "https://example.com/login",
        title: submitted ? "Account" : "Login",
        text: submitted ? "signed in" : "login form",
        length: 10,
        hash: submitted ? "hash-2" : "hash-1",
        documentId: submitted ? "doc-2" : "doc-1",
      }),
      type: async (target) => {
        typed.push({ id: target.id, text: target.text })
        return { typed: true }
      },
      click: async (target) => {
        clicked.push(target.id ?? "")
        submitted = true
        return { clicked: true }
      },
    }
    // The submit control is only discoverable by its own label.
    if (submitLabel !== undefined) {
      const inner = browser.find
      browser.find = async (query, role) => {
        const found = await inner(query, role)
        if (query.toLowerCase() !== submitLabel.toLowerCase()) return found
        return [{ id: "submit-1", role: "button", name: submitLabel, score: 1 }, ...found]
      }
    }
    return { browser, typed, clicked }
  }

  test("types the stored username and secret, submits, and verifies", async () => {
    const harness = loginHarness(
      { "field-user": "Email address", "field-pass": "Password", "field-code": "One-time code" },
      "Sign in",
    )
    const { driver } = baseDriver({ browser: harness.browser })
    const { manager, credentials, events } = createManager(driver)
    const credential = credentials.save({ computerId: "local", name: "login", secret: SECRET, username: USERNAME })
    const outcome = await manager.execute("local", {
      action: "browser_login",
      credential: credential.id,
      expect: { urlContains: "/account" },
      ...approval,
    })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.verification?.status).toBe("verified")
    expect(outcome.result.verification?.method).toBe("browser-login-readback")
    expect(harness.typed).toEqual([
      { id: "field-user", text: USERNAME },
      { id: "field-pass", text: SECRET },
    ])
    expect(harness.clicked).toEqual(["submit-1"])
    // Zero-trust: the secret never reaches the model-visible result.
    expect(JSON.stringify(outcome.result)).not.toContain(SECRET)
    expect(outcome.result.metadata?.submitted).toBe(true)
    expect(events.since(0).some((event) => event.type === "credential.used")).toBe(true)
  })

  test("fills without submitting when submit is false", async () => {
    const harness = loginHarness({ "field-user": "Email", "field-pass": "Password" }, "Sign in")
    const { driver } = baseDriver({ browser: harness.browser })
    const { manager, credentials } = createManager(driver)
    const credential = credentials.save({ computerId: "local", name: "login", secret: SECRET, username: USERNAME })
    const outcome = await manager.execute("local", {
      action: "browser_login",
      credential: credential.name,
      submit: false,
      ...approval,
    })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.verification?.status).toBe("unverified")
    expect(harness.typed).toHaveLength(2)
    expect(harness.clicked).toEqual([])
  })

  test("a rejected login that re-renders the same form is unverified, not verified", async () => {
    // Same URL after submit: the form is still there, so nothing proves the
    // credential was accepted.
    const harness = loginHarness({ "field-user": "Email address", "field-pass": "Password" }, "Sign in", {
      keepForm: true,
    })
    const inner = harness.browser.read
    harness.browser.read = async () => ({ ...(await inner()), url: "https://example.com/login" })
    const { driver } = baseDriver({ browser: harness.browser })
    const { manager, credentials } = createManager(driver)
    const credential = credentials.save({ computerId: "local", name: "login", secret: SECRET, username: USERNAME })
    const outcome = await manager.execute("local", { action: "browser_login", credential: credential.id, ...approval })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.verification?.status).toBe("unverified")
    expect(outcome.result.verification?.message).toContain("password field again")
    expect(harness.typed).toHaveLength(2)
  })

  test("navigating away without a declared expectation is unverified, not accepted", async () => {
    // The page leaves the form (a rejected login does exactly this) but
    // nothing the caller declared proves the credential was accepted.
    const harness = loginHarness({ "field-user": "Email address", "field-pass": "Password" }, "Sign in")
    const { driver } = baseDriver({ browser: harness.browser })
    const { manager, credentials } = createManager(driver)
    const credential = credentials.save({ computerId: "local", name: "login", secret: SECRET, username: USERNAME })
    const outcome = await manager.execute("local", { action: "browser_login", credential: credential.id, ...approval })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.verification?.status).toBe("unverified")
    expect(outcome.result.verification?.message).toContain("Leaving the form is not proof")
  })

  test("follows a two-step sign-in across pages, typing each field once", async () => {
    // Google-style: page one asks for the identifier only, page two for the
    // secret. One call must walk both and type each field exactly once.
    const typed: Array<{ id: string; text: string }> = []
    const clicked: string[] = []
    let step = 0
    const browser: BrowserController = {
      ...browserHarness().browser,
      find: async (query) => {
        if (step > 1) return []
        const fields =
          step === 0
            ? [{ id: "field-user", role: "textbox", name: "Email", score: 1 }]
            : [
                { id: "field-pass", role: "textbox", name: "Password", score: 1 },
                { id: "field-user", role: "textbox", name: "Email", score: 1 },
              ]
        const matches = fields.filter((entry) => entry.name.toLowerCase().includes(query.toLowerCase()))
        if (query.toLowerCase() === "next" || query.toLowerCase() === "continue")
          return [{ id: "submit-1", role: "button", name: "Next", score: 1 }]
        return matches
      },
      read: async () => ({
        url:
          step === 0
            ? "https://accounts.example.com/signin"
            : step === 1
              ? "https://accounts.example.com/signin/password"
              : "https://accounts.example.com/myaccount",
        title: "Sign in",
        text: step === 0 ? "Email" : step === 1 ? "Password" : "Log out",
        length: 5,
        hash: `hash-${step}`,
        documentId: `doc-${step}`,
      }),
      type: async (target) => {
        typed.push({ id: target.id, text: target.text })
        return { typed: true }
      },
      click: async (target) => {
        clicked.push(target.id ?? "")
        step += 1
        return { clicked: true }
      },
    }
    const { driver } = baseDriver({ browser })
    const { manager, credentials } = createManager(driver)
    const credential = credentials.save({ computerId: "local", name: "login", secret: SECRET, username: USERNAME })
    const outcome = await manager.execute("local", {
      action: "browser_login",
      credential: credential.id,
      identifierFirst: true,
      expect: { urlContains: "/myaccount" },
      ...approval,
    })
    expect(outcome.result.success).toBe(true)
    // Each field typed exactly once: the secret never re-enters a page.
    expect(typed).toEqual([
      { id: "field-user", text: USERNAME },
      { id: "field-pass", text: SECRET },
    ])
    expect(clicked).toEqual(["submit-1", "submit-1"])
    expect(JSON.stringify(outcome.result)).not.toContain(SECRET)
    expect(outcome.result.verification?.status).toBe("verified")
    expect((outcome.result.metadata?.steps as unknown[]).length).toBe(2)
  })

  test("an identifier-only page is refused unless the flow is declared", async () => {
    // Same two-step page, but the caller did not declare it: nothing is typed,
    // so an ordinary form with an email box is never turned into a login.
    const harness = loginHarness({ "field-user": "Email address" }, "Subscribe")
    const { driver } = baseDriver({ browser: harness.browser })
    const { manager, credentials } = createManager(driver)
    const credential = credentials.save({ computerId: "local", name: "login", secret: SECRET, username: USERNAME })
    const outcome = await manager.execute("local", { action: "browser_login", credential: credential.id, ...approval })
    expect(outcome.result.success).toBe(false)
    expect(errorCode(outcome.result.error)).toBe("login_field_not_found")
    expect(harness.typed).toEqual([])
  })

  test("never resubmits the same form after a rejection", async () => {
    const harness = loginHarness({ "field-user": "Email address", "field-pass": "Password" }, "Sign in", {
      keepForm: true,
    })
    const inner = harness.browser.read
    harness.browser.read = async () => ({ ...(await inner()), url: "https://example.com/login" })
    const { driver } = baseDriver({ browser: harness.browser })
    const { manager, credentials } = createManager(driver)
    const credential = credentials.save({ computerId: "local", name: "login", secret: SECRET, username: USERNAME })
    const outcome = await manager.execute("local", {
      action: "browser_login",
      credential: credential.id,
      expect: { urlContains: "/account" },
      ...approval,
    })
    expect(outcome.result.verification?.status).toBe("unverified")
    // One submit only: the loop must stop instead of trying again.
    expect(harness.clicked).toEqual(["submit-1"])
    expect(harness.typed).toHaveLength(2)
  })

  test("fails closed without typing when the password field cannot be identified", async () => {
    const harness = loginHarness({ "field-user": "Email address", "field-submit": "Search" })
    const { driver } = baseDriver({ browser: harness.browser })
    const { manager, credentials } = createManager(driver)
    const credential = credentials.save({ computerId: "local", name: "login", secret: SECRET, username: USERNAME })
    const outcome = await manager.execute("local", { action: "browser_login", credential: credential.id, ...approval })
    expect(outcome.result.success).toBe(false)
    expect(errorCode(outcome.result.error)).toBe("login_field_not_found")
    expect(harness.typed).toEqual([])
  })

  test("fails closed rather than putting the secret in an unidentified field", async () => {
    const harness = loginHarness({ "field-pass": "Password", "field-note": "Recovery code" }, "Sign in")
    const { driver } = baseDriver({ browser: harness.browser })
    const { manager, credentials } = createManager(driver)
    const credential = credentials.save({ computerId: "local", name: "login", secret: SECRET, username: USERNAME })
    const outcome = await manager.execute("local", { action: "browser_login", credential: credential.id, ...approval })
    expect(outcome.result.success).toBe(false)
    expect(errorCode(outcome.result.error)).toBe("login_field_not_found")
    expect(harness.typed).toEqual([])
  })

  test("requires a stored credential and never accepts a secret in the request", async () => {
    const harness = loginHarness({ "field-user": "Email", "field-pass": "Password" }, "Sign in")
    const { driver } = baseDriver({ browser: harness.browser })
    const { manager } = createManager(driver)
    const missing = await manager.execute("local", { action: "browser_login", ...approval })
    expect(missing.result.success).toBe(false)
    expect(errorCode(missing.result.error)).toBe("invalid_action")
    expect(harness.typed).toEqual([])
    const inline = await manager.execute("local", {
      action: "browser_login",
      password: SECRET,
      ...approval,
    })
    expect(inline.result.success).toBe(false)
    expect(harness.typed).toEqual([])
  })

  test("explicit field ids drive a form with no usable field names", async () => {
    const harness = loginHarness({ "omnia-7": "field-a", "omnia-9": "field-b" })
    const { driver } = baseDriver({ browser: harness.browser })
    const { manager, credentials } = createManager(driver)
    const credential = credentials.save({ computerId: "local", name: "login", secret: SECRET, username: USERNAME })
    const outcome = await manager.execute("local", {
      action: "browser_login",
      credential: credential.id,
      usernameField: "omnia-7",
      passwordField: "omnia-9",
      submit: false,
      ...approval,
    })
    expect(outcome.result.success).toBe(true)
    expect(harness.typed).toEqual([
      { id: "omnia-7", text: USERNAME },
      { id: "omnia-9", text: SECRET },
    ])
  })
})
