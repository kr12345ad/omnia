import { plugin } from "bun"
import { createRequire } from "node:module"
import { realpathSync } from "node:fs"
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { resolveTemplate } from "@solid-primitives/i18n"
import { createComponent, insert, isServer, render } from "solid-js/web"
import { dict as en } from "@/i18n/en"

// Bun has no Solid JSX transform, so the ui-kit surface under test goes through
// the same esbuild + babel-preset-solid pipeline the app build uses. The app's
// entitlement owner has no JSX in it, so its fresh instances load as they are.
const fromApp = createRequire(import.meta.url)
const fromVite = createRequire(realpathSync(fromApp.resolve("vite")))
const fromVitePluginSolid = createRequire(realpathSync(fromApp.resolve("vite-plugin-solid")))
const esbuild = fromVite("esbuild") as {
  transform(source: string, options: Record<string, unknown>): Promise<{ code: string }>
}
const babel = fromVitePluginSolid("@babel/core") as {
  transformAsync(source: string, options: Record<string, unknown>): Promise<{ code?: string } | null>
}
const solidPreset = fromVitePluginSolid("babel-preset-solid")

const UI_SOURCE = /\/ui\/src\/(components\/(paywall|button|icon)|context\/i18n)\.tsx$/

plugin({
  name: "entitlement-upgrade-solid-jsx-test",
  setup(build) {
    // Stylesheets carry no behaviour under test, and Bun cannot import CSS.
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: "export default {}", loader: "js" }))
    build.onLoad({ filter: UI_SOURCE }, async (args) => {
      const source = await Bun.file(args.path).text()
      const stripped = await esbuild.transform(source, { loader: "tsx", jsx: "preserve" })
      const result = await babel.transformAsync(stripped.code, {
        filename: args.path,
        presets: [[solidPreset, { generate: "dom", hydratable: false }]],
        configFile: false,
        babelrc: false,
        sourceMaps: false,
      })
      return { contents: result?.code ?? stripped.code, loader: "js" }
    })
  },
})

// Sibling test files import ui components too, and whichever of them Bun loads
// first wins the module registry. Substituting the two leaf dependencies keeps
// this file independent of the run order; both stand-ins render the real elements
// (a native <button>, an aria-hidden icon), so the assertions below still describe
// shipped behaviour.
mock.module("@opencode-ai/ui/button", () => ({
  Button: (props: {
    children?: unknown
    disabled?: boolean
    onClick?: () => void
    class?: string
    "aria-label"?: string
    "data-slot"?: string
  }) => {
    const button = document.createElement("button")
    button.type = "button"
    button.disabled = props.disabled === true
    if (props.class) button.className = props.class
    if (props["aria-label"]) button.setAttribute("aria-label", props["aria-label"])
    if (props["data-slot"]) button.setAttribute("data-slot", props["data-slot"])
    button.addEventListener("click", () => props.onClick?.())
    insert(button, () => props.children)
    return button
  },
}))
mock.module("@opencode-ai/ui/icon", () => ({
  Icon: (props: { name?: string; size?: string; class?: string }) => {
    const icon = document.createElement("span")
    icon.setAttribute("data-component", "icon")
    icon.setAttribute("aria-hidden", "true")
    if (props.name) icon.setAttribute("name", props.name)
    return icon
  },
}))

const opened: string[] = []
mock.module("@/context/platform", () => ({
  usePlatform: () => ({
    platform: "desktop",
    openExternal: (url: string) => opened.push(url),
  }),
}))

// Billing owns the sentence it reports a failure in, so the language context is
// the real English dictionary rather than a stand-in: what the user ends up
// reading is the thing under test.
mock.module("@/context/language", () => ({
  useLanguage: () => ({
    locale: () => "en",
    t: (key: string, params?: Record<string, string | number | boolean>) =>
      resolveTemplate(en[key as keyof typeof en] ?? String(key), params),
  }),
}))

// The toast sink, so a failure that was reported can be read back instead of
// hunted for in a portal.
const toasts: { title?: string; description?: string; variant?: string }[] = []
mock.module("@/utils/toast", () => ({
  showToast: (options: { title?: string; description?: string; variant?: string }) => {
    toasts.push(options)
    return toasts.length
  },
}))

const ui = isServer ? undefined : await import("@opencode-ai/ui/paywall")
type Entitlement = typeof import("@/context/entitlement")
type Snapshot = ReturnType<Entitlement["useEntitlement"]>

type Decision = {
  code: "granted" | "limit_reached" | "not_entitled" | "unknown"
  metering?: "hard" | "soft"
  used?: number
  limit?: number
  reason?: string
}

/**
 * A free profile, and a Business one that is unlimited everywhere.
 *
 * `computers: null` and `limit: null` are what the server actually sends for an
 * unlimited plan: `Infinity` does not survive JSON.
 */
const FREE = {
  plan: "free",
  computers: 3,
  monthlyUsd: 0,
  billingConfigured: true,
  capabilities: { cloud_vision: { allowed: false, code: "not_entitled", used: 0, limit: 0 } },
} as const

const BUSINESS = {
  plan: "business",
  computers: null,
  monthlyUsd: 49,
  billingConfigured: true,
  capabilities: { remote_computer: { allowed: true, code: "granted", used: 41, limit: null } },
} as const

let windows = 0

/**
 * One owner per account under test.
 *
 * The snapshot is window-wide state on purpose: one entitlement read per window
 * and one metered read per capability, which is what stops mounting a notice from
 * becoming a request storm. It is also what stops two accounts being described in
 * one test process, because the second account is never read. Bun keys modules by
 * specifier, so each window asks for its own instance of the owner.
 */
function owner() {
  return import(`@/context/entitlement?window=${windows++}`) as Promise<Entitlement>
}

/** The fake preload bridge, so a test states an account and nothing else. */
function installBilling(input: { account: unknown; decisions?: Record<string, Decision>; refuses?: string }) {
  const checkouts: string[] = []
  let portals = 0
  const api = {
    entitlement: async () => input.account,
    check: async (capability: string) => input.decisions?.[capability] ?? { code: "granted", used: 0, limit: 0 },
    checkout: async (plan: string) => {
      checkouts.push(plan)
      if (input.refuses !== undefined)
        throw new Error(`Error invoking remote method 'billing-checkout': Error: ${input.refuses}`)
      return `https://checkout.example/${plan}`
    },
    portal: async () => {
      portals += 1
      return "https://billing.example/portal"
    },
  }
  ;(window as unknown as { api: { billing: unknown } }).api = { billing: api }
  return { checkouts, portals: () => portals }
}

/** One macrotask, which drains the entitlement promise chain and its store write. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function mount(capability: string) {
  const entitlement = await owner()
  const container = document.createElement("div")
  document.body.appendChild(container)
  const held: { snapshot?: Snapshot } = {}
  function Notice() {
    const snapshot = entitlement.useEntitlement()
    const decision = entitlement.useEntitlementDecision(capability)
    held.snapshot = snapshot
    return createComponent(ui!.Paywall, {
      capability,
      get decision() {
        return decision()
      },
      get offer() {
        return snapshot.offer()
      },
      onDismiss: () => snapshot.dismiss(capability),
    })
  }
  const dispose = render(() => createComponent(Notice, {}), container)
  await settle()
  return {
    snapshot: () => held.snapshot!,
    surface: () => container.querySelector("[data-component=paywall]"),
    async upgrade() {
      container.querySelector<HTMLButtonElement>("[data-slot=paywall-upgrade]")!.click()
      await settle()
    },
    unmount() {
      dispose()
      container.remove()
    },
  }
}

beforeEach(() => {
  opened.length = 0
  toasts.length = 0
})

afterAll(() => {
  document.body.replaceChildren()
})

describe.skipIf(isServer)("entitlement upgrade", () => {
  test("a profile with no subscription starts a purchase, because a portal cannot exist for one", async () => {
    const billing = installBilling({
      account: FREE,
      decisions: { cloud_vision: { code: "not_entitled", metering: "hard" } },
    })

    const notice = await mount("cloud_vision")
    const surface = notice.surface()!

    // Nothing is invented for a plan the server prices at nothing: "free" and
    // "$0.00" beside an Upgrade button are figures nobody can act on.
    expect(surface.textContent).toContain("A paid plan adds Cloud vision.")
    expect(surface.textContent).not.toContain("$0")
    expect(surface.querySelector("[data-slot=paywall-price]")).toBeNull()

    await notice.upgrade()

    // The control plane answers the portal route for a profile with no
    // subscription with 404, so this is the only request that can work here.
    expect(billing.checkouts).toEqual(["pro"])
    expect(billing.portals()).toBe(0)
    expect(opened).toEqual(["https://checkout.example/pro"])
    expect(toasts).toEqual([])
    notice.unmount()
  })

  test("an account with a subscription is sent to the portal, and pays to see what it pays", async () => {
    const billing = installBilling({
      account: BUSINESS,
      decisions: { audit_export: { code: "not_entitled", metering: "hard" } },
    })

    const notice = await mount("audit_export")
    const surface = notice.surface()!

    // Both the plan and the figure are the response's, so a rename or a price
    // change is a server-side edit rather than a stale button label.
    expect(surface.textContent).toContain("Upgrading to business adds audit_export.")
    expect(surface.querySelector("[data-slot=paywall-price]")!.textContent).toContain("$49")

    await notice.upgrade()

    expect(billing.portals()).toBe(1)
    expect(billing.checkouts).toEqual([])
    expect(opened).toEqual(["https://billing.example/portal"])
    expect(toasts).toEqual([])
    notice.unmount()
  })

  test("a refused checkout says so instead of doing nothing at all", async () => {
    const billing = installBilling({
      account: FREE,
      decisions: { cloud_vision: { code: "not_entitled", metering: "hard" } },
      refuses: "Billing is not configured on this server.",
    })

    const notice = await mount("cloud_vision")
    await notice.upgrade()

    // Silence here is what made the paywall useless: a click that opens no tab
    // and says nothing reads as a broken app, not as a declined purchase.
    expect(billing.checkouts).toEqual(["pro"])
    expect(opened).toEqual([])
    expect(toasts.length).toBe(1)
    expect(toasts[0].variant).toBe("error")
    // The server's own sentence, unwrapped from the shape Electron rejects with.
    expect(toasts[0].description).toBe("Billing is not configured on this server.")
    expect(toasts[0].title).toBe("Billing")

    // The notice is still standing: what it explained has not changed.
    expect(notice.surface()).not.toBeNull()
    notice.unmount()
  })

  test("a transport failure is reported in designed copy rather than as a stack", async () => {
    installBilling({
      account: FREE,
      decisions: { cloud_vision: { code: "not_entitled", metering: "hard" } },
      refuses: "TypeError: fetch failed",
    })

    const notice = await mount("cloud_vision")
    await notice.upgrade()

    expect(toasts.length).toBe(1)
    expect(toasts[0].description).toBe("Cannot reach Omnia right now. Check your internet connection and try again.")
    notice.unmount()
  })

  test("an unlimited allowance reads as unlimited rather than as zero or null", async () => {
    installBilling({
      account: BUSINESS,
      decisions: { live_view: { code: "limit_reached", metering: "soft", used: 4_200 } },
    })

    const notice = await mount("live_view")

    // Infinity does not survive JSON, so an unlimited plan arrives as null.
    // Reading that as 0 is how a Business subscriber is told they have nothing
    // left of every capability they bought without limit.
    expect(notice.snapshot().account()!.computers).toBeUndefined()
    expect(notice.snapshot().account()!.capabilities.remote_computer.limit).toBeUndefined()
    expect(notice.snapshot().account()!.capabilities.remote_computer.used).toBe(41)

    const surface = notice.surface()!
    expect(surface.getAttribute("data-tone")).toBe("fair-use")
    expect(surface.textContent).toContain("It still works")
    // No ceiling to draw, so no usage bar and no invented numbers.
    expect(surface.querySelector("[data-slot=paywall-usage]")).toBeNull()
    expect(surface.textContent).not.toContain("null")
    expect(surface.textContent).not.toContain("0 of 0")
    notice.unmount()
  })
})
