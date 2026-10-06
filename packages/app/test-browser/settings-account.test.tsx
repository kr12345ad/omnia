import { plugin } from "bun"
import { createRequire } from "node:module"
import { realpathSync } from "node:fs"
import { afterAll, describe, expect, mock, test } from "bun:test"
import { flatten, resolveTemplate } from "@solid-primitives/i18n"
import { createComponent, isServer, render } from "solid-js/web"
import { dict as en } from "@/i18n/en"
import { dict as uiEn } from "@opencode-ai/ui/i18n/en"

// Bun has no Solid JSX transform, so the surface under test goes through the
// same esbuild + babel-preset-solid pipeline the app build uses. Only this
// file's component is transformed: the ui kit resolves to its built output,
// exactly like the usage-limits harness.
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

plugin({
  name: "settings-account-solid-jsx-test",
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: "export default {}", loader: "js" }))
    build.onLoad(
      { filter: /\/(ui\/src\/.*|app\/src\/components\/settings-account-view)\.tsx(?:\?.*)?$/ },
      async (args) => {
        const path = args.path.split("?")[0]
        const source = await Bun.file(path).text()
        const stripped = await esbuild.transform(source, { loader: "tsx", jsx: "preserve" })
        const local = createRequire(path)
        // Retag ONLY the component under test's own imports. Shared ui files
        // loaded by anyone else pass through with plain specifiers, so this
        // file can neither inherit another suite's mocks nor impose its own:
        // its world is the ?settings-account copies, everyone else keeps the
        // shared ones.
        const mine = path.endsWith("/app/src/components/settings-account-view.tsx")
        const isolated = mine
          ? stripped.code.replace(
              /(from\s*|import\s*)(["'])([^"']+)\2/g,
              (match: string, prefix: string, quote: string, specifier: string) => {
                const tag = (target: string) => `${prefix}${quote}${target}?settings-account${quote}`
                if (
                  specifier === "@/context/entitlement" ||
                  specifier === "@/context/language" ||
                  specifier === "@/context/platform"
                ) {
                  return tag(specifier)
                }
                if (!specifier.startsWith("@opencode-ai/ui/")) return match
                const resolved = local.resolve(specifier)
                if (!resolved.includes("/ui/src/") || !resolved.endsWith(".tsx")) return match
                return `${prefix}${quote}${resolved}?settings-account${quote}`
              },
            )
          : stripped.code
        const result = await babel.transformAsync(isolated, {
          filename: path,
          presets: [[solidPreset, { generate: "dom", hydratable: false }]],
          configFile: false,
          babelrc: false,
          sourceMaps: false,
        })
        return { contents: result?.code ?? stripped.code, loader: "js" }
      },
    )
  },
})

// Real dictionaries, so copy assertions describe shipped text. The settings and
// paywall keys this surface needs now live in en.ts and ui en.ts.
const dictionary: Record<string, string> = flatten({ ...en, ...uiEn })

mock.module("@/context/language?settings-account", () => ({
  useLanguage: () => ({
    locale: () => "en",
    intl: () => "en-US",
    t: (key: string, params?: Record<string, string | number | boolean>) => {
      const value = dictionary[key]
      return value === undefined ? undefined : resolveTemplate(value, params)
    },
  }),
}))

mock.module("@/context/platform?settings-account", () => ({
  usePlatform: () => ({ openExternal: () => undefined }),
}))

// A free, configured account mid-cycle: one finite row half spent, one spent,
// one unlimited, one excluded, and computers partially registered.
const RESETS_AT = Date.UTC(2026, 9, 7)
const ACCOUNT = {
  billingConfigured: true,
  plan: "free",
  monthlyUsd: 0,
  computers: 3,
  computersUsed: 1,
  capabilities: {
    browser_automation: {
      allowed: true,
      code: "granted",
      used: 250,
      limit: 500,
      metering: "hard",
      period: "day",
      resetsAt: RESETS_AT,
    },
    vault_login: { allowed: true, code: "granted", used: 3, limit: 3, metering: "hard", period: "month" },
    // null is how Infinity arrives off the wire; the page must read it as
    // unlimited, never unknown.
    local_computer: { allowed: true, code: "granted", used: 0, limit: null },
    remote_shell: { allowed: false, code: "not_entitled", used: 0, limit: 0 },
  },
}

function installBridge() {
  ;(window as unknown as { api?: unknown }).api = {
    billing: {
      entitlement: async () => ACCOUNT,
      check: async () => undefined,
      checkout: async () => undefined,
      portal: async () => undefined,
    },
  }
}

function removeBridge() {
  ;(window as unknown as { api?: unknown }).api = undefined
}

// No mock for @/context/entitlement: the component reads a fresh real copy
// (query-tagged below, so its window-wide store cannot leak into or out of any
// other file) fed by a stubbed window.api.billing bridge, exactly like the
// entitlement-upgrade suite does.

mock.module("@/context/entitlement?settings-account", () => ({
  useEntitlement: () => ({
    account: () => ACCOUNT,
    reload: () => Promise.resolve(),
    offer: () => undefined,
    check: () => Promise.resolve(undefined),
    decision: () => undefined,
    dismissed: () => false,
    dismiss: () => undefined,
  }),
  checkoutPlan: () => Promise.resolve(true),
  openBillingPortal: () => Promise.resolve(true),
}))

const { SettingsAccount } = isServer
  ? ({} as { SettingsAccount: never })
  : await import("@/components/settings-account-view?settings-account")

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function mount() {
  installBridge()
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(() => createComponent(SettingsAccount, {}), container)
  await settle()
  return {
    container,
    text: () => container.textContent ?? "",
    bar: (name: string) => {
      const row = [...container.querySelectorAll('[data-slot="account-limit"]')].find((entry) =>
        entry.textContent?.includes(name),
      )
      return row?.querySelector('[role="progressbar"]') ?? null
    },
    unmount() {
      dispose()
      container.remove()
      removeBridge()
    },
  }
}

afterAll(() => {
  document.body.replaceChildren()
})

describe.skipIf(isServer)("settings account", () => {
  test("every finite allowance gets a real progress bar, unlimited rows get none", async () => {
    const surface = await mount()
    const browser = surface.bar("Browser automation")
    expect(browser?.getAttribute("aria-valuenow")).toBe("250")
    expect(browser?.getAttribute("aria-valuemax")).toBe("500")
    const vault = surface.bar("Vault sign-ins")
    expect(vault?.getAttribute("aria-valuenow")).toBe("3")
    // Unlimited allowances get no row at all, so there is no bar to mistake
    // for spent and no "Unlimited" text burying the real ceilings.
    expect(surface.text()).not.toContain("Local computer")
    expect(surface.text()).not.toContain("Unlimited")
    surface.unmount()
  })

  test("computers show registered against allowed", async () => {
    const surface = await mount()
    expect(surface.text()).toContain("1 of 3 computers")
    surface.unmount()
  })

  test("upgrade buttons follow the plan and manage stays subscriber-only", async () => {
    const surface = await mount()
    const buttons = [...surface.container.querySelectorAll("button")]
    const named = (name: string) => buttons.find((button) => button.textContent?.includes(name))
    // Free with billing configured: both upgrades enabled, portal disabled.
    expect(named("Upgrade to Pro")?.hasAttribute("disabled")).toBe(false)
    expect(named("Upgrade to Business")?.hasAttribute("disabled")).toBe(false)
    expect(named("Manage Billing")?.hasAttribute("disabled")).toBe(true)
    surface.unmount()
  })
})
