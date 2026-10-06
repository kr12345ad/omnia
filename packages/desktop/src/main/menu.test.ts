import { plugin } from "bun"
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import type { MenuItemConstructorOptions } from "electron"
import {
  createDesktopNativeBundle,
  DESKTOP_NATIVE_ENGLISH,
  formatDesktopNativeMessage,
  type DesktopNativeKey,
} from "@opencode-ai/app/i18n/desktop-native"
import type { PlanId } from "@opencode-ai/omnia/billing/plans"
import type { BillingAccount, BillingAccountNotice } from "./omnia/billing"

// menu.ts builds an Electron menu and asks the control plane who the user is.
// Only those two surfaces are substituted: Electron, and the billing read that
// is the menu's one external answer. The shared template, the plan ranking, and
// the translated copy stay real, so every assertion here is about the menu a
// person is handed rather than about the stubs.
//
// The signed-in session and the control-plane URL behind that read are stubbed
// too, and only because loading them would evaluate the remote agent and the
// keychain that own them: a module evaluated here keeps this file's Electron for
// the rest of the run, which is how auth.test.ts came to find a keychain that
// was never there. The gating is still the shipped one - read from a copy that
// no other file can be given - and the stubs are handed back at the end so the
// files that own these modules read them for real.

type Item = MenuItemConstructorOptions

// Every export of each stubbed module, so a name a later file reads is a
// stand-in that can become the real one rather than missing from the module.
const BILLING_EXPORTS = [
  "BILLING_CHANNELS",
  "canManageBilling",
  "canUpgradeTo",
  "checkBillingCapability",
  "readBillingAccount",
  "readBillingEntitlement",
  "registerBillingIpcHandlers",
  "startBillingCheckout",
  "startBillingPortal",
] as const satisfies readonly (keyof typeof import("./omnia/billing"))[]

const REMOTE_AGENT_EXPORTS = [
  "agentEventSource",
  "createRemoteBrowserHandler",
  "loadRemoteAgentConfig",
  "normalizeControlPlaneUrl",
  "persistRemoteAgentConfig",
  "readControlPlaneUrl",
  "readRegisteredComputerId",
  "registerRemoteAgentIpcHandlers",
  "registerWithControlPlane",
  "resolveJoinServer",
  "resolvedControlPlaneUrl",
  "setNativeActionObserver",
  "setRemoteBrowserHandler",
  "syncControlPlaneRegistration",
  "withNativeActionTracking",
  "writeControlPlaneUrl",
] as const satisfies readonly (keyof typeof import("./omnia/remote-agent"))[]

const installed: Item[][] = []
const listeners = new Map<string, (() => void)[]>()
const dialogs: unknown[][] = []
const opened: string[] = []
const logged: unknown[][] = []
const focused = { name: "main" }

const fakeElectron = {
  app: {
    isPackaged: false,
    getPath: () => "",
    on: (event: string, listener: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    },
  },
  BrowserWindow: { getFocusedWindow: (): { name: string } | undefined => undefined },
  dialog: {
    showMessageBox: (...args: unknown[]) => {
      dialogs.push(args)
      return Promise.resolve({ response: 0 })
    },
  },
  Menu: {
    buildFromTemplate: (template: Item[]) => ({ template }),
    setApplicationMenu: (menu: { template: Item[] }) => installed.push(menu.template),
  },
  ipcMain: { handle: () => undefined },
}

plugin({
  name: "omnia-menu-electron",
  setup(build) {
    build.module("electron", () => ({ exports: { ...fakeElectron, default: fakeElectron }, loader: "object" }))
  },
})

mock.module("./windows", () => ({
  openExternalURL: (url: string) => opened.push(url),
  createMainWindow: () => undefined,
  updateTitlebar: () => undefined,
}))
mock.module("./logging", () => ({ write: (...args: unknown[]) => logged.push(args) }))

/** A copy of a module under a query of its own, which the shared registry cannot answer. */
function privateCopy<T>(path: string, tag: string) {
  return require(`${path}?${tag}`) as T
}

// Bun shares one module registry across the files in a run, and a module that is
// evaluated here keeps this file's Electron for the rest of it. So the three
// modules behind the menu's one external answer are answered here instead of
// loaded, and each of their exports is a stand-in: it answers for this file
// until this file is done, and is the module's own export afterwards, read from a
// copy that then loads under the Electron of whichever file is asking.
let answering = true

function standIn(path: string, names: readonly string[], mine: Record<string, unknown>) {
  const answer = (name: string) =>
    answering ? mine[name] : privateCopy<Record<string, unknown>>(path, "own")[name]
  const exports: Record<string, unknown> = {}
  for (const name of names)
    Object.defineProperty(exports, name, {
      enumerable: true,
      configurable: true,
      get: () =>
        new Proxy(() => undefined, {
          apply: (_target, _this, args) => Reflect.apply(answer(name) as (...args: unknown[]) => unknown, undefined, args),
          get: (_target, key) => Reflect.get(answer(name) as object, key),
        }),
    })
  return exports
}

mock.module("./omnia/remote-agent", () =>
  standIn("./omnia/remote-agent", REMOTE_AGENT_EXPORTS, { readControlPlaneUrl: () => undefined }),
)
mock.module("./omnia/auth-session", () =>
  standIn("./omnia/auth-session", ["readAuthSession", "readSessionProfileId"], {
    readAuthSession: () => undefined,
    readSessionProfileId: () => undefined,
  }),
)

// The real gating travels with the stub: canUpgradeTo and canManageBilling are
// the shipped ones, read from a copy nothing else can be handed.
const shipped = privateCopy<typeof import("./omnia/billing")>("./omnia/billing", "shipped")

let account: BillingAccount = { plan: undefined, billingConfigured: false, notice: undefined }
let checkout: (plan: string) => Promise<string> = async (plan) => `https://checkout.stripe.com/c/pay/${plan}`
let portal: () => Promise<string> = async () => "https://billing.stripe.com/p/session"

mock.module("./omnia/billing", () =>
  standIn("./omnia/billing", BILLING_EXPORTS, {
    ...shipped,
    readBillingAccount: async () => account,
    startBillingCheckout: (plan: string) => checkout(plan),
    startBillingPortal: () => portal(),
  }),
)

const { ControlPlaneRequestError } = await import("./omnia/control-plane")
const { setNativeTranslations } = await import("./native-translations")

const deps = { trigger: () => undefined, checkForUpdates: () => undefined, relaunch: () => undefined }
const hostPlatform = process.platform
const english = createDesktopNativeBundle("en", (key) => DESKTOP_NATIVE_ENGLISH[key])

/** The account the control plane reports for a user who is signed in. */
function signedIn(plan: PlanId): BillingAccount {
  return { plan, billingConfigured: true, notice: undefined }
}

const notices = [
  { notice: "signed_out", key: "desktop.billing.signedOut" },
  { notice: "unconfigured", key: "desktop.billing.notConfigured" },
  { notice: "unreachable", key: "desktop.billing.unreachable" },
] as const satisfies readonly { notice: BillingAccountNotice; key: DesktopNativeKey }[]

/** Every notice but unconfigured arrives without a plan; unconfigured knows it. */
function blocked(notice: BillingAccountNotice): BillingAccount {
  return { plan: notice === "unconfigured" ? "free" : undefined, billingConfigured: false, notice }
}

/** The unresolved state menu.ts starts in, before any answer has arrived. */
const unanswered: BillingAccount = { plan: undefined, billingConfigured: false, notice: undefined }

const actions = ["desktop.menu.upgradePro", "desktop.menu.upgradeBusiness", "desktop.menu.manageBilling"] as const

const copy = (key: DesktopNativeKey, params?: Record<string, string | number>) =>
  formatDesktopNativeMessage(DESKTOP_NATIVE_ENGLISH[key], params)

function findItem(items: Item[], key: DesktopNativeKey, params?: Record<string, string | number>) {
  const found = items.find((item) => item.label === copy(key, params))
  if (found === undefined) throw new Error(`no ${key} in ${JSON.stringify(items.map((item) => item.label))}`)
  return found
}

function click(item: Item) {
  // Electron hands a click the built menu item; the menu's own handlers ignore
  // all three arguments and act on what they closed over.
  item.click?.(undefined as never, undefined as never, undefined as never)
}

function enabled(items: Item[], key: DesktopNativeKey, params?: Record<string, string | number>) {
  return findItem(items, key, params).enabled
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

let loaded = 0

/** A private instance per case, because createMenu caches the resolved account. */
async function freshMenu() {
  return await import(`./menu?case=${++loaded}`)
}

function installedMenu() {
  const template = installed.at(-1)
  if (template === undefined) throw new Error("no menu was installed")
  return template
}

/** The account rows, wherever this platform hangs the group. */
function groupOf(template: Item[], label = copy("desktop.menu.account")) {
  const app = (template.find((item) => item.label === copy("desktop.menu.app"))?.submenu ?? []) as Item[]
  const group = [...template, ...app].find((item) => item.label === label)
  if (group?.submenu === undefined) throw new Error(`no account group in ${JSON.stringify(template.map((i) => i.label))}`)
  return group.submenu as Item[]
}

function submenu(item: Item | undefined) {
  return (item?.submenu ?? []) as Item[]
}

/** The sentence the last dialog showed, whether or not a window carried it. */
function lastMessage() {
  const shown = dialogs.flat().at(-1)
  if (typeof shown !== "object" || shown === null || !("message" in shown)) throw new Error("no dialog was shown")
  return String(shown.message)
}

async function render(input: BillingAccount, platform = "darwin") {
  account = input
  Object.defineProperty(process, "platform", { value: platform, configurable: true })
  const menu = await freshMenu()
  menu.createMenu(deps)
  await settle()
  return installedMenu()
}

beforeEach(() => {
  installed.length = 0
  dialogs.length = 0
  opened.length = 0
  logged.length = 0
  listeners.clear()
  account = unanswered
  checkout = async (plan) => `https://checkout.stripe.com/c/pay/${plan}`
  portal = async () => "https://billing.stripe.com/p/session"
  setNativeTranslations(english)
})

afterEach(() => {
  Object.defineProperty(process, "platform", { value: hostPlatform, configurable: true })
})

// The menu is done with these three, so the stand-ins stop answering for them:
// remote-agent.test.ts needs the real remote agent and the real session it reads,
// and billing.test.ts needs a billing module that registers its IPC handlers on
// the Electron that file registers rather than on this one.
afterAll(() => {
  answering = false
})

describe("account group placement", () => {
  test("hangs the account group off the application menu, next to settings", async () => {
    const template = await render(signedIn("pro"))
    const labels = submenu(template.find((item) => item.label === copy("desktop.menu.app"))).map((item) => item.label)

    expect(labels).toContain(copy("desktop.menu.account"))
    expect(labels.indexOf(copy("desktop.menu.account"))).toBe(labels.indexOf(copy("desktop.menu.settings")) + 1)
    // macOS keeps the group inside the application menu rather than beside it.
    expect(template.map((item) => item.label)).not.toContain(copy("desktop.menu.account"))
  })

  test("appends the account group to the menu on Windows and Linux", async () => {
    for (const platform of ["win32", "linux"]) {
      installed.length = 0
      const template = await render(signedIn("pro"), platform)

      expect(template.at(-1)?.label).toBe(copy("desktop.menu.account"))
      expect(groupOf(template)).toContainEqual(expect.objectContaining({ label: copy("desktop.menu.plan", { plan: "pro" }) }))
      // The application menu is macOS-shaped and stays out of a Windows menu.
      expect(template.find((item) => item.label === copy("desktop.menu.app"))).toBeUndefined()
    }
  })

  test("builds a Windows menu Electron can take", async () => {
    const template = await render(signedIn("free"), "win32")

    // A menu item is either a separator, a native role, or something with a
    // label; anything else is a template buildFromTemplate refuses.
    for (const item of template.flatMap(entries)) {
      if (item.type === "separator" || item.role !== undefined) continue
      expect(typeof item.label === "string" && item.label.length > 0).toBe(true)
    }
    expect(template.length).toBeGreaterThan(1)
  })

  test("builds a Windows menu with Windows accelerators and no Command key", async () => {
    const template = await render(signedIn("free"), "win32")
    const file = submenu(template.find((item) => item.label === copy("desktop.menu.file")))

    expect(file.find((item) => item.label === copy("desktop.menu.settings"))?.accelerator).toBe("Ctrl+,")
    expect(JSON.stringify(template)).not.toContain("Cmd+")
  })
})

describe("account rows", () => {
  test("shows the current plan as a row that does nothing", async () => {
    const plan = findItem(groupOf(await render(signedIn("business"))), "desktop.menu.plan", { plan: "business" })

    expect(plan.label).toBe("Plan: business")
    expect(plan.enabled).toBe(false)
    expect(plan.click).toBeUndefined()
  })

  test("enables an upgrade only when the current plan ranks below it", async () => {
    const offered = {
      free: { pro: true, business: true },
      pro: { pro: false, business: true },
      business: { pro: false, business: false },
      // Enterprise outranks the paid tiers without carrying a price.
      enterprise: { pro: false, business: false },
    } as const

    for (const plan of ["free", "pro", "business", "enterprise"] as const) {
      const group = groupOf(await render(signedIn(plan)))
      expect(enabled(group, "desktop.menu.upgradePro")).toBe(offered[plan].pro)
      expect(enabled(group, "desktop.menu.upgradeBusiness")).toBe(offered[plan].business)
    }
  })

  test("opens billing management only for an account with a subscription", async () => {
    expect(enabled(groupOf(await render(signedIn("free"))), "desktop.menu.manageBilling")).toBe(false)
    for (const plan of ["pro", "business", "enterprise"] as const) {
      expect(enabled(groupOf(await render(signedIn(plan))), "desktop.menu.manageBilling")).toBe(true)
    }
    for (const { notice } of notices) {
      expect(enabled(groupOf(await render(blocked(notice))), "desktop.menu.manageBilling")).toBe(false)
    }
    expect(enabled(groupOf(await render(unanswered)), "desktop.menu.manageBilling")).toBe(false)
  })

  test("gives every notice its own row and disables every action", async () => {
    for (const { notice, key } of notices) {
      const group = groupOf(await render(blocked(notice)))
      const row = findItem(group, key)

      expect(row.label).toBe(copy(key))
      expect(row.enabled).toBe(false)
      expect(row.click).toBeUndefined()
      for (const action of actions) expect(enabled(group, action)).toBe(false)
    }
  })

  test("leaves no clickable item the server would refuse", async () => {
    const granted = [signedIn("free"), signedIn("pro"), signedIn("enterprise")]
    const refused = notices.map((entry) => blocked(entry.notice))

    for (const state of [...granted, ...refused, unanswered]) {
      const group = groupOf(await render(state))
      // Nothing is offered enabled unless something happens when it is chosen.
      expect(group.filter((item) => item.enabled !== false && item.type !== "separator" && item.click === undefined)).toEqual(
        [],
      )
      // A refusal leaves the whole group inert: no item a click could dead-end.
      if (state.plan === undefined || state.notice !== undefined)
        expect(group.filter((item) => item.click !== undefined).every((item) => item.enabled === false)).toBe(true)
    }
  })
})

describe("the unanswered account", () => {
  test("says nothing about the user until the control plane answers", async () => {
    account = signedIn("pro")
    const menu = await freshMenu()
    menu.createMenu(deps)

    // Read the menu that was installed before the entitlement call came back:
    // a signed-in user with a slow control plane must not be told to sign in,
    // must not be shown a plan, and must not be offered anything.
    const pending = groupOf(installedMenu())
    expect(pending.map((item) => item.label)).not.toContain(copy("desktop.billing.signedOut"))
    expect(pending.some((item) => typeof item.label === "string" && item.label.includes("Sign in"))).toBe(false)
    expect(pending.some((item) => typeof item.label === "string" && item.label.startsWith("Plan:"))).toBe(false)
    for (const action of actions) expect(enabled(pending, action)).toBe(false)

    await settle()
    const resolved = groupOf(installedMenu())
    expect(findItem(resolved, "desktop.menu.plan", { plan: "pro" }).label).toBe("Plan: pro")
    expect(enabled(resolved, "desktop.menu.upgradeBusiness")).toBe(true)
  })

  test("re-reads the plan when a window regains focus after a checkout", async () => {
    expect(enabled(groupOf(await render(signedIn("free"))), "desktop.menu.upgradePro")).toBe(true)

    account = signedIn("pro")
    for (const listener of listeners.get("browser-window-focus") ?? []) listener()
    await settle()

    const group = groupOf(installedMenu())
    expect(findItem(group, "desktop.menu.plan", { plan: "pro" }).label).toBe("Plan: pro")
    expect(enabled(group, "desktop.menu.upgradePro")).toBe(false)
    expect(enabled(group, "desktop.menu.upgradeBusiness")).toBe(true)
  })

  test("keeps one focus hook however often the menu is rebuilt", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
    const menu = await freshMenu()
    account = signedIn("free")
    menu.createMenu(deps)
    await settle()
    const hooked = listeners.get("browser-window-focus")?.length ?? 0
    expect(hooked).toBe(1)

    account = signedIn("pro")
    menu.createMenu(deps)
    await settle()

    expect(listeners.get("browser-window-focus")).toHaveLength(hooked)
    expect(findItem(groupOf(installedMenu()), "desktop.menu.plan", { plan: "pro" }).label).toBe("Plan: pro")
  })
})

describe("account copy", () => {
  test("labels the group from the bundle the app is running in", async () => {
    // The German bundle's own words for these keys, so a locale cannot silently
    // fall back to the English source compiled into menu.ts.
    setNativeTranslations({
      locale: "de",
      messages: {
        ...english.messages,
        "desktop.menu.account": "Konto",
        "desktop.menu.plan": "Tarif: {{plan}}",
        "desktop.billing.unreachable": "Omnia konnte den Server nicht erreichen, um Ihren Tarif zu prüfen.",
      },
    })

    const subscribed = await render(signedIn("pro"))
    expect(groupOf(subscribed, "Konto")).toContainEqual(expect.objectContaining({ label: "Tarif: pro" }))

    const unreachable = await render(blocked("unreachable"))
    expect(groupOf(unreachable, "Konto").map((item) => item.label)).toContain(
      "Omnia konnte den Server nicht erreichen, um Ihren Tarif zu prüfen.",
    )
  })

  test("falls back to English for a bundle that predates the Account keys", async () => {
    // A bundle missing a key resolves it to nothing at all, and a menu item with
    // no label is worse than an English one: this is what ACCOUNT_COPY is for.
    const stale = {
      ...english.messages,
      "desktop.menu.plan": undefined,
    } as unknown as typeof english.messages
    setNativeTranslations({ locale: "de", messages: stale })

    const template = await render(signedIn("pro"))

    expect(findItem(groupOf(template), "desktop.menu.plan", { plan: "pro" }).label).toBe("Plan: pro")
  })
})

describe("billing failures", () => {
  test("starts a checkout in the browser when an upgrade is enabled", async () => {
    const group = groupOf(await render(signedIn("free")))

    click(findItem(group, "desktop.menu.upgradePro"))
    await settle()

    expect(opened).toEqual(["https://checkout.stripe.com/c/pay/pro"])
  })

  test("opens the billing portal for a subscriber", async () => {
    const group = groupOf(await render(signedIn("business")))

    click(findItem(group, "desktop.menu.manageBilling"))
    await settle()

    expect(opened).toEqual(["https://billing.stripe.com/p/session"])
  })

  test("reports a refused checkout as the server's sentence, never as a stack", async () => {
    checkout = async () => {
      throw new ControlPlaneRequestError("Billing is not configured on this server.", 503)
    }
    const group = groupOf(await render(signedIn("free")))

    click(findItem(group, "desktop.menu.upgradePro"))
    await settle()

    const [options] = dialogs.at(-1) ?? []
    expect(options).toEqual({
      type: "error",
      title: "Billing",
      message: "Billing is not configured on this server.",
    })
    expect(lastMessage().split("\n")).toHaveLength(1)
    expect(lastMessage()).not.toContain("    at ")
    expect(opened).toEqual([])
    expect(logged.at(-1)?.slice(0, 2)).toEqual(["billing", "checkout failed"])
  })

  test("replaces a dropped connection with a sentence the user can read", async () => {
    checkout = async () => {
      throw new TypeError("fetch failed")
    }
    const group = groupOf(await render(signedIn("free")))

    click(findItem(group, "desktop.menu.upgradeBusiness"))
    await settle()

    expect(lastMessage()).toBe("Omnia could not reach the server to check your plan.")
    expect(logged.at(-1)?.slice(0, 2)).toEqual(["billing", "checkout failed"])
  })

  test("raises the failure on the window the user came back to", async () => {
    fakeElectron.BrowserWindow.getFocusedWindow = () => focused
    checkout = async () => {
      throw new ControlPlaneRequestError("Sign in before upgrading.", 401)
    }
    try {
      const group = groupOf(await render(signedIn("free")))
      click(findItem(group, "desktop.menu.upgradePro"))
      await settle()
    } finally {
      fakeElectron.BrowserWindow.getFocusedWindow = () => undefined
    }

    expect(dialogs.at(-1)).toEqual([
      focused,
      { type: "error", title: "Billing", message: "Sign in before upgrading." },
    ])
  })
})

/** Every entry in a template, submenu included, for checking it can be built. */
function entries(item: Item): Item[] {
  return [item, ...submenu(item).flatMap(entries)]
}