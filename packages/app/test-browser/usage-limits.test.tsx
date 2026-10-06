import { plugin } from "bun"
import { createRequire } from "node:module"
import { realpathSync } from "node:fs"
import { afterAll, describe, expect, mock, test } from "bun:test"
import { flatten, resolveTemplate } from "@solid-primitives/i18n"
import { createComponent, isServer, render } from "solid-js/web"

if (typeof document === "undefined") {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator")
  GlobalRegistrator.register()
}

// Bun has no Solid JSX transform, so the surface under test goes through the
// same esbuild + babel-preset-solid pipeline the app build uses.
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

const APP_SOURCE = /\/app\/src\/components\/settings-usage\.tsx$/

plugin({
  name: "settings-usage-solid-jsx-test",
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: "export default {}", loader: "js" }))
    build.onLoad({ filter: APP_SOURCE }, async (args) => {
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

// The real English dictionaries, so these assertions describe shipped copy
// rather than a mock's idea of it.
//
// The two groups below are the keys this surface needs and neither dictionary
// belongs to this change, so the strings are pinned here and reported for
// `src/i18n/en.ts` and `@opencode-ai/ui/i18n/en.ts`. Pinning them means the
// wording is asserted either way, and these lines become redundant the moment
// the keys land. A key neither dictionary holds still resolves to undefined,
// exactly as the real translator resolves it, which is what lets the surface
// fall back to a capability id instead of rendering a blank name.
const { dict: appDict } = await import("@/i18n/en")
const { dict: uiDict } = await import("@opencode-ai/ui/i18n/en")

const dictionary: Record<string, string> = {
  ...flatten({ ...appDict, ...uiDict }),
  "settings.usage.title": "Usage limits",
  "settings.usage.description": "What your plan allows, before a limit stops you.",
  "settings.usage.unavailable": "Sign in to see what your plan allows.",
  "settings.usage.unlimited": "Unlimited",
  "settings.usage.allowed": "{{limit}} allowed",
  "settings.usage.used": "{{used}} of {{limit}} used",
  "settings.usage.usedPerDay": "{{used}} of {{limit}} used per day",
  "settings.usage.usedPerMonth": "{{used}} of {{limit}} used this month",
  "settings.usage.sessionLength": "{{minutes}} minutes per remote session",
  "ui.paywall.capability.localComputer": "Local computer",
  "ui.paywall.capability.remoteComputer": "Remote computer",
  "ui.paywall.capability.inputFreeze": "Input freeze",
  "ui.paywall.capability.browserAutomation": "Browser automation",
  "ui.paywall.capability.liveView": "Live view",
  "ui.paywall.capability.subagents": "Subagents",
  "ui.paywall.capability.apiAccess": "API access",
  "ui.paywall.capability.webhooks": "Webhooks",
  "ui.paywall.capability.auditExport": "Audit export",
  "ui.paywall.capability.rbac": "Role-based access",
  "ui.paywall.capability.sso": "Single sign-on",
  "ui.paywall.capability.selfHosted": "Self hosting",
}

mock.module("@/context/language", () => ({
  useLanguage: () => ({
    locale: () => "en",
    intl: () => "en",
    t: (key: string, params?: Record<string, string | number | boolean>) => {
      const value = dictionary[key]
      return value === undefined ? undefined : resolveTemplate(value, params)
    },
  }),
}))

const { SettingsUsage } = isServer ? ({} as { SettingsUsage: never }) : await import("@/components/settings-usage")

/**
 * The free tier as the entitlement response reports it.
 *
 * A fair-use allowance is Infinity on the server and arrives as null, which is
 * why `local_computer` and `remote_computer` carry null rather than a number.
 * The order is the server's, and the surface must not impose one of its own.
 */
const FREE = {
  plan: "free",
  computers: 3,
  billingConfigured: true,
  monthlyUsd: 0,
  capabilities: {
    local_computer: { allowed: true, code: "granted", used: 1, limit: null },
    remote_computer: { allowed: true, code: "granted", used: 0, limit: null },
    input_freeze: { allowed: false, code: "not_entitled", used: 0, limit: 0 },
    remote_shell: { allowed: false, code: "not_entitled", used: 0, limit: 0 },
    clipboard: { allowed: false, code: "not_entitled", used: 0, limit: 0 },
    browser_automation: { allowed: true, code: "granted", used: 12, limit: 250 },
    credential_vault: { allowed: true, code: "granted", used: 1, limit: 1 },
    vault_login: { allowed: true, code: "granted", used: 1, limit: 3 },
    live_view: { allowed: true, code: "granted", used: 4, limit: 20 },
    subagents: { allowed: true, code: "granted", used: 1, limit: 2 },
  },
}

/** The fake preload bridge, so a test states an entitlement and nothing else. */
function installBilling(answer: unknown | "unreadable" | undefined) {
  if (answer === undefined) {
    ;(window as unknown as { api?: unknown }).api = undefined
    return
  }
  const api = {
    entitlement: async () => {
      if (answer === "unreadable") throw new Error("billing is unreachable")
      return answer
    },
  }
  ;(window as unknown as { api: { billing: unknown } }).api = { billing: api }
}

/** One macrotask, which drains the entitlement promise chain and its store write. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * The surface on its own.
 *
 * `undefined` leaves the bridge off entirely, which is the browser build and any
 * test with no preload at all: there is nothing to say about the account, and
 * that is not the same as having no plan.
 */
async function mount(answer: unknown | "unreadable" | undefined) {
  installBilling(answer)
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(() => createComponent(SettingsUsage, {}), container)
  await settle()
  const rows = () => [...container.querySelectorAll("[data-slot=usage-limit]")]
  const row = (name: string) => rows().find((entry) => entry.querySelector("dt")?.textContent?.includes(name))
  return {
    container,
    text: () => container.textContent ?? "",
    rows,
    row,
    value: (name: string) => row(name)?.querySelector("dd")?.textContent,
    unmount() {
      dispose()
      container.remove()
    },
  }
}

afterAll(() => {
  document.body.replaceChildren()
})

describe.skipIf(isServer)("usage limits in settings", () => {
  test("an unlimited allowance reads as unlimited, never as 0 and never as null", async () => {
    const surface = await mount(FREE)

    expect(surface.value("Local computer")).toBe("Unlimited")
    expect(surface.value("Remote computer")).toBe("Unlimited")
    // The one case with no ceiling at all must not read as a spent allowance.
    expect(surface.text()).not.toContain("null")
    expect(surface.rows().map((row) => row.querySelector("dd")!.textContent)).not.toContain("0")
    surface.unmount()
  })

  test("a daily allowance is named daily and a monthly one monthly", async () => {
    const surface = await mount(FREE)

    // browser_automation is the one daily rule in the free matrix, and the
    // wording for it must not be the monthly one every other allowance uses.
    expect(surface.value("Browser automation")).toBe("12 of 250 used per day")
    expect(surface.value("Vault sign-ins")).toBe("1 of 3 used this month")
    // The same capability is a monthly budget on other plans, so the period is
    // never a property of the capability id.
    expect(surface.value("Credential vault")).toBe("1 of 1 used this month")
    surface.unmount()
  })

  test("the used count and the limit are both shown against each other", async () => {
    const surface = await mount(FREE)

    expect(surface.value("Browser automation")).toContain("12 of 250")
    expect(surface.value("Live view")).toBe("4 of 20 used this month")
    expect(surface.value("Subagents")).toBe("1 of 2 used this month")
    surface.unmount()
  })

  test("the computer allowance is a ceiling, not a monthly budget", async () => {
    const surface = await mount(FREE)

    expect(surface.value("Computers")).toBe("3 allowed")
    // No counter is kept for computers, so no monthly period may be claimed.
    expect(surface.value("Computers")).not.toContain("month")
    surface.unmount()
  })

  test("the remote session ceiling is disclosed next to the capability it caps", async () => {
    const surface = await mount(FREE)

    const term = surface.row("Remote computer")!.querySelector("dt")!.textContent ?? ""
    expect(term).toContain("120 minutes per remote session")
    surface.unmount()
  })

  test("a capability the plan does not include is not listed as a zero", async () => {
    const surface = await mount(FREE)

    expect(surface.row("Input freeze")).toBeUndefined()
    expect(surface.row("Clipboard sync")).toBeUndefined()
    expect(surface.rows().length).toBe(8)
    surface.unmount()
  })

  test("a plan this build cannot resolve claims no period at all", async () => {
    const surface = await mount({
      plan: "platinum",
      computers: 3,
      billingConfigured: true,
      monthlyUsd: 0,
      capabilities: { vault_login: { allowed: true, code: "granted", used: 2, limit: 9 } },
    })

    expect(surface.value("Vault sign-ins")).toBe("2 of 9 used")
    surface.unmount()
  })

  test("a capability the plan matrix has no rule for claims no period and no name", async () => {
    const surface = await mount({
      plan: "free",
      computers: 3,
      billingConfigured: true,
      monthlyUsd: 0,
      capabilities: { some_new_capability: { allowed: true, code: "granted", used: 1, limit: 4 } },
    })

    // The id shows rather than nothing, exactly as the paywall names a
    // capability it has no label for, and no period is invented for it.
    expect(surface.value("some_new_capability")).toBe("1 of 4 used")
    surface.unmount()
  })

  test("each allowance is a term and a value, so a screen reader reads the pair", async () => {
    const surface = await mount(FREE)

    const list = surface.container.querySelector("dl")!
    expect(list.children.length).toBe(surface.rows().length)
    for (const row of surface.rows()) {
      expect(row.querySelectorAll("dt").length).toBe(1)
      expect(row.querySelectorAll("dd").length).toBe(1)
      // The numbers are text, not a colour and not a bar nobody can read.
      expect(row.querySelector("dd")!.textContent?.length).toBeGreaterThan(0)
    }
    surface.unmount()
  })

  test("an entitlement that could not be read shows no numbers and refuses nothing", async () => {
    const surface = await mount("unreadable")

    expect(surface.rows().length).toBe(0)
    expect(surface.text()).toContain("Sign in to see what your plan allows.")
    // Informational only: nothing here can block, hide or disable a feature.
    expect(surface.container.querySelectorAll("button, input, select").length).toBe(0)
    surface.unmount()
  })

  test("no entitlement at all reads as no answer rather than as a free plan", async () => {
    const surface = await mount(undefined)

    expect(surface.rows().length).toBe(0)
    expect(surface.text()).toContain("Sign in to see what your plan allows.")
    expect(surface.text()).not.toContain("allowed")
    surface.unmount()
  })
})
