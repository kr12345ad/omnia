import { plugin } from "bun"
import { createRequire } from "node:module"
import { realpathSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { resolveTemplate } from "@solid-primitives/i18n"
import { createComponent, isServer, render } from "solid-js/web"
import { dict as en } from "@/i18n/en"

// Exercise the shipped dropdown and menu with the app's Solid JSX transform.
const fromApp = createRequire(import.meta.url)
const fromVite = createRequire(realpathSync(fromApp.resolve("vite")))
const fromSolid = createRequire(realpathSync(fromApp.resolve("vite-plugin-solid")))
const esbuild = fromVite("esbuild")
const babel = fromSolid("@babel/core")
const solidPreset = fromSolid("babel-preset-solid")
plugin({
  name: "account-menu-refresh-solid",
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: "export default {}", loader: "js" }))
    build.onLoad({ filter: /\/(ui\/src\/.*|app\/src\/components\/windows-app-menu)\.tsx(?:\?.*)?$/ }, async (args) => {
      const path = args.path.split("?")[0]
      // Keep actual UI components, isolated from sibling tests' JSX transforms.
      const source = await Bun.file(path).text()
      const stripped = await esbuild.transform(source, { loader: "tsx", jsx: "preserve" })
      const local = createRequire(path)
      const isolated = stripped.code.replace(
        /(from\s*|import\s*)(["'])([^"']+)\2/g,
        (match: string, prefix: string, quote: string, specifier: string) => {
          if (!path.endsWith("windows-app-menu.tsx") && !args.path.includes("?account-menu-refresh")) return match
          if (!specifier.startsWith("@opencode-ai/ui/") && !specifier.startsWith(".")) return match
          const resolved = local.resolve(specifier)
          if (!resolved.includes("/ui/src/") || !resolved.endsWith(".tsx")) return match
          return `${prefix}${quote}${resolved}?account-menu-refresh${quote}`
        },
      )
      const result = await babel.transformAsync(isolated, {
        filename: path,
        presets: [[solidPreset, { generate: "dom", hydratable: false }]],
        configFile: false,
        babelrc: false,
        sourceMaps: false,
      })
      return { contents: result?.code ?? stripped.code, loader: "js" }
    })
  },
})

const platform = { platform: "desktop" as const, openExternal: () => undefined }
let accountLabel: string = en["desktop.menu.account"]
mock.module("@/context/platform", () => ({ usePlatform: () => platform }))
mock.module("@/context/language", () => ({
  useLanguage: () => ({
    locale: () => "en",
    t: (key: string, params?: Record<string, string | number | boolean>) =>
      key === "desktop.menu.account" ? accountLabel : resolveTemplate(en[key as keyof typeof en], params),
  }),
}))
const app = isServer ? undefined : await import("@/components/windows-app-menu")
const cleanups: (() => void)[] = []
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const bridge = isServer ? undefined : (window as unknown as { api: unknown })
const originalAPI = bridge?.api

function billing(read: () => Promise<unknown>) {
  const entitlement = mock(read)
  const checkout = mock(async () => "https://checkout.example/pro")
  const portal = mock(async () => "https://billing.example/portal")
  bridge!.api = {
    billing: { entitlement, checkout, portal },
  }
  return { entitlement, checkout, portal }
}

async function mount(variant: "legacy" | "v2") {
  const container = document.createElement("div")
  document.body.append(container)
  const trigger = mock((_id: string) => undefined)
  const dispose = render(
    () =>
      createComponent(app!.WindowsAppMenu, {
        command: {
          options: [{ id: "settings.account", title: en["desktop.menu.account"] }],
          keybind: () => undefined,
          trigger,
        } as never,
        platform: platform as never,
        variant,
      }),
    container,
  )
  cleanups.push(() => {
    dispose()
    container.remove()
  })
  await settle()
  return { trigger, container }
}

function row(label: string) {
  const item = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find((item) => item.textContent === label)
  if (!item) throw new Error(`Missing menu row: ${label}`)
  return item
}

async function openMenu(container: HTMLElement) {
  const trigger = container.querySelector<HTMLElement>("[data-slot=dropdown-menu-trigger]")!
  trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
  await settle()
}

beforeEach(() => {
  accountLabel = en["desktop.menu.account"]
})
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  if (bridge) bridge.api = originalAPI
})

describe.skipIf(isServer)("Account menu navigation", () => {
  const states = [
    { name: "pending", read: () => new Promise<unknown>(() => undefined) },
    { name: "signed out", read: async () => undefined },
    { name: "unconfigured", read: async () => ({ plan: "free", billingConfigured: false }) },
    {
      name: "unreachable",
      read: async () => {
        throw new Error("unreachable")
      },
    },
  ]

  for (const variant of ["legacy", "v2"] as const) {
    for (const state of states) {
      test(`${variant} Account is a direct enabled Settings action when billing is ${state.name}`, async () => {
        const backend = billing(state.read)
        const view = await mount(variant)
        await openMenu(view.container)
        const account = row(en["desktop.menu.account"])
        expect(account.hasAttribute("data-disabled")).toBe(false)
        expect(account.hasAttribute("aria-haspopup")).toBe(false)
        expect(document.querySelectorAll("[role=menu]")).toHaveLength(1)
        for (const key of [
          "desktop.menu.upgradePro",
          "desktop.menu.upgradeBusiness",
          "desktop.menu.manageBilling",
        ] as const)
          expect(document.body.textContent).not.toContain(en[key])
        account.focus()
        account.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
        await settle()
        expect(view.trigger.mock.calls).toEqual([["settings.account"]])
        expect(backend.entitlement.mock.calls).toHaveLength(0)
        expect(backend.checkout.mock.calls).toHaveLength(0)
        expect(backend.portal.mock.calls).toHaveLength(0)
      })
    }
  }

  test("uses the existing translated Account label for pointer navigation", async () => {
    accountLabel = "Konto"
    const view = await mount("v2")
    await openMenu(view.container)
    row("Konto").dispatchEvent(new PointerEvent("pointerup", { button: 0, pointerType: "mouse", bubbles: true }))
    await settle()
    expect(view.trigger.mock.calls).toEqual([["settings.account"]])
  })
})
