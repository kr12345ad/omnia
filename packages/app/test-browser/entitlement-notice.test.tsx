import { plugin } from "bun"
import { createRequire } from "node:module"
import { realpathSync } from "node:fs"
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { resolveTemplate } from "@solid-primitives/i18n"
import { createSignal } from "solid-js"
import { createComponent, insert, isServer, render } from "solid-js/web"
import { dict as en } from "@/i18n/en"

if (typeof document === "undefined") {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator")
  GlobalRegistrator.register()
}

// Bun has no Solid JSX transform, so the sources under test go through the same
// esbuild + babel-preset-solid pipeline the app build uses: the app's
// entitlement owner and notice, and the ui-kit surface they render.
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
const APP_SOURCE = /\/app\/src\/(context\/entitlement|components\/prompt-input\/entitlement-notice)\.tsx$/

plugin({
  name: "entitlement-notice-solid-jsx-test",
  setup(build) {
    // Stylesheets carry no behaviour under test, and Bun cannot import CSS.
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: "export default {}", loader: "js" }))
    build.onLoad({ filter: new RegExp(`${UI_SOURCE.source}|${APP_SOURCE.source}`) }, async (args) => {
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
// this file independent of the run order; both stand-ins render the real
// elements (a native <button>, an aria-hidden icon), so the accessibility
// assertions below still describe shipped behaviour.
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

// Billing owns the copy it reports a failure in, so the language context is the
// real English dictionary rather than a stand-in: the sentence a user ends up
// reading is the thing under test.
mock.module("@/context/language", () => ({
  useLanguage: () => ({
    locale: () => "en",
    t: (key: string, params?: Record<string, string | number | boolean>) =>
      resolveTemplate(en[key as keyof typeof en] ?? String(key), params),
  }),
}))

// The toast sink, so nothing in this file can reach the real one.
mock.module("@/utils/toast", () => ({
  showToast: () => 0,
}))

// The notice only appears once the user has asked for a shell, and the terminal
// panel's open state lives in the session layout, so that is the only part of it
// these tests have to stand in for.
const [panelOpened, setPanelOpened] = createSignal(false)
mock.module("@/pages/session/session-layout", () => ({
  useSessionLayout: () => ({ view: () => ({ terminal: { opened: () => panelOpened() } }) }),
}))

const ui = isServer ? undefined : await import("@opencode-ai/ui/paywall")
const app = isServer
  ? undefined
  : {
      ...(await import("@/context/entitlement")),
      ...(await import("@/components/prompt-input/entitlement-notice")),
    }

type Decision = {
  code: "granted" | "limit_reached" | "not_entitled" | "unknown"
  metering?: "hard" | "soft"
  used?: number
  limit?: number
  reason?: string
}

/** The fake preload bridge, so a test states a decision and nothing else. */
function installBilling(input: {
  account?: unknown | "unreadable"
  decisions?: Record<string, Decision | "unreadable">
  checkout?: string
}) {
  const asked: string[] = []
  const checkouts: string[] = []
  const api = {
    entitlement: async () => {
      if (input.account === "unreadable") throw new Error("billing is unreachable")
      return input.account ?? { plan: "free", computers: 3, capabilities: {}, billingConfigured: true, monthlyUsd: 0 }
    },
    check: async (capability: string) => {
      asked.push(capability)
      const decision = input.decisions?.[capability]
      if (decision === "unreadable") throw new Error("billing is unreachable")
      return decision ?? { code: "granted", used: 0, limit: 0 }
    },
    checkout: async (plan: string) => {
      checkouts.push(plan)
      if (input.checkout !== undefined) throw new Error(input.checkout)
      return `https://checkout.example/${plan}`
    },
    portal: async () => "https://billing.example/portal",
  }
  ;(window as unknown as { api: { billing: unknown } }).api = { billing: api }
  return { asked, checkouts }
}

/** One macrotask, which drains the entitlement promise chain and its store write. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function mount(component: () => unknown) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(component as () => undefined, container)
  return {
    container,
    surface: () => container.querySelector("[data-component=paywall]"),
    unmount() {
      dispose()
      container.remove()
    },
  }
}

/** The same two props every capability surface passes, for one capability. */
function Notice(props: { capability: string }) {
  const entitlement = app!.useEntitlement()
  const decision = app!.useEntitlementDecision(props.capability)
  return createComponent(ui!.Paywall, {
    capability: props.capability,
    get decision() {
      return decision()
    },
    get offer() {
      return entitlement.offer()
    },
  })
}

beforeEach(() => {
  opened.length = 0
  setPanelOpened(false)
})

afterAll(() => {
  document.body.replaceChildren()
})

// The snapshot owner is window-wide on purpose, so these read the same answers
// in the order they are declared: the account read is retried after a failure
// and each capability is only ever asked once.
describe.skipIf(isServer)("entitlement notices", () => {
  test("a refused capability is still explained when the account could not be read", async () => {
    installBilling({ account: "unreadable", decisions: { cloud_vision: { code: "not_entitled", metering: "hard" } } })

    const notice = mount(() => createComponent(Notice, { capability: "cloud_vision" }))
    await settle()

    const surface = notice.surface()!
    expect(surface.getAttribute("data-tone")).toBe("locked")
    expect(surface.textContent).toContain("Cloud vision is not included in your plan")
    // Nothing can be sold, so nothing is offered: an upgrade button that quietly
    // does nothing is worse than the explanation on its own.
    expect(surface.querySelector("[data-slot=paywall-upgrade]")).toBeNull()
    expect(opened).toEqual([])
    notice.unmount()
  })

  test("a refused remote shell is explained without opening the terminal panel", async () => {
    const billing = installBilling({ decisions: { remote_shell: { code: "not_entitled", metering: "hard" } } })

    const notice = mount(() => createComponent(app!.RemoteShellNotice, {}))
    await settle()

    // The panel is inert and aria-hidden while it is closed, so a notice that
    // only lived in there would be invisible to everyone - and a user who never
    // reaches for a shell is never asked about one.
    expect(notice.container.querySelector("[data-component=paywall]")).toBeNull()
    expect(billing.asked).toEqual([])

    setPanelOpened(true)
    await settle()

    const surface = notice.container.querySelector("[data-component=paywall]")!
    expect(surface.getAttribute("data-tone")).toBe("locked")
    expect(surface.getAttribute("role")).toBe("group")
    // Announced, not colour-only: the group is labelled by its own title.
    expect(surface.querySelector(`#${surface.getAttribute("aria-labelledby")}`)!.textContent).toContain(
      "Remote shell is not included in your plan",
    )

    const upgrade = surface.querySelector<HTMLButtonElement>("[data-slot=paywall-upgrade]")!
    expect(upgrade.textContent).toContain("Upgrade")
    upgrade.click()
    await settle()
    // A free profile has no Stripe customer, so the portal route answers 404 for
    // one: the CTA starts a purchase instead, which is the only thing that can
    // actually happen here.
    expect(billing.checkouts).toEqual(["pro"])
    expect(opened).toEqual(["https://checkout.example/pro"])

    // The panel owns its own copy too, and asking for one decision per
    // capability is the whole point of the snapshot.
    expect(billing.asked).toEqual(["remote_shell"])
    notice.unmount()
  })

  test("closing the remote shell notice keeps it away for the rest of the window", async () => {
    installBilling({ decisions: { remote_shell: { code: "not_entitled", metering: "hard" } } })
    setPanelOpened(true)

    const notice = mount(() => createComponent(app!.RemoteShellNotice, {}))
    await settle()

    notice.container.querySelector<HTMLButtonElement>("[data-slot=paywall-dismiss]")!.click()
    await settle()

    expect(notice.container.querySelector("[data-component=paywall]")).toBeNull()
    notice.unmount()
  })

  test("a soft limit is a notice that says the feature still works, not an error", async () => {
    installBilling({
      decisions: {
        clipboard: { code: "limit_reached", metering: "soft", used: 250, limit: 300 },
      },
    })

    const notice = mount(() => createComponent(Notice, { capability: "clipboard" }))
    await settle()

    const surface = notice.surface()!
    expect(surface.getAttribute("data-tone")).toBe("fair-use")
    // A polite live region, never an assertive alert.
    expect(surface.getAttribute("role")).toBe("status")
    expect(surface.textContent).toContain("Clipboard sync is past its fair-use allowance")
    expect(surface.textContent).toContain("It still works")
    expect(surface.textContent).toContain("250 of 300 used this period")
    expect(surface.querySelector("[data-component=icon][name=warning]")).toBeNull()
    notice.unmount()
  })

  test("a granted capability renders nothing at all", async () => {
    const billing = installBilling({ decisions: { credential_vault: { code: "granted", used: 1, limit: 1 } } })

    const notice = mount(() => createComponent(Notice, { capability: "credential_vault" }))
    await settle()

    expect(notice.container.childNodes.length).toBe(0)
    expect(notice.container.textContent).toBe("")
    expect(billing.asked).toEqual(["credential_vault"])
    notice.unmount()
  })

  test("a decision that could not be read renders nothing and blocks nothing", async () => {
    const billing = installBilling({ decisions: { scheduled_runs: "unreadable" } })

    const notice = mount(() => createComponent(Notice, { capability: "scheduled_runs" }))
    await settle()

    expect(notice.container.childNodes.length).toBe(0)
    expect(notice.container.textContent).toBe("")
    // A refusal we could not read is our outage, not the user's, so it is never
    // rendered as one.
    expect(opened).toEqual([])
    expect(billing.asked).toEqual(["scheduled_runs"])
    notice.unmount()
  })

  test("a bridge that answers nothing at all leaves every surface empty", async () => {
    ;(window as unknown as { api?: unknown }).api = undefined

    const notice = mount(() => createComponent(Notice, { capability: "browser_automation" }))
    await settle()

    expect(notice.container.childNodes.length).toBe(0)
    notice.unmount()
  })

  test("asks a capability once no matter how many surfaces read it", async () => {
    const billing = installBilling({ decisions: { live_view: { code: "not_entitled", metering: "hard" } } })

    const first = mount(() => createComponent(Notice, { capability: "live_view" }))
    const second = mount(() => createComponent(Notice, { capability: "live_view" }))
    await settle()

    expect(first.surface()).not.toBeNull()
    expect(second.surface()).not.toBeNull()
    expect(billing.asked).toEqual(["live_view"])
    first.unmount()
    second.unmount()
  })
})
