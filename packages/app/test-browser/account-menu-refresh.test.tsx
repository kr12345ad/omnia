import { plugin } from "bun"
import { createRequire } from "node:module"
import { realpathSync } from "node:fs"
import { afterEach, describe, expect, mock, test } from "bun:test"
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
      // Neither the account cache nor JSX modules previously loaded by sibling
      // tests may supply this menu's dependencies. Keep the actual UI components,
      // but load private copies through this file's Solid transform.
      const source = (await Bun.file(path).text()).replace(
        '"@/context/entitlement"',
        '"@/context/entitlement?account-menu-refresh"',
      )
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
mock.module("@/context/platform", () => ({ usePlatform: () => platform }))
mock.module("@/context/language", () => ({
  useLanguage: () => ({
    locale: () => "en",
    t: (key: string, params?: Record<string, string | number | boolean>) =>
      resolveTemplate(en[key as keyof typeof en], params),
  }),
}))
mock.module("@/utils/toast", () => ({ showToast: () => 0 }))

const app = isServer ? undefined : await import("@/components/windows-app-menu")
const owner = isServer
  ? undefined
  : await (import("@/context/entitlement?account-menu-refresh" as string) as Promise<
      typeof import("@/context/entitlement")
    >)
type Snapshot = ReturnType<NonNullable<typeof owner>["useEntitlement"]>

const free = { plan: "free", billingConfigured: false, monthlyUsd: 0, capabilities: {} }
const configured = { ...free, billingConfigured: true }
const pro = { ...configured, plan: "pro" }
const cleanups: (() => void)[] = []
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function billing(
  read: () => Promise<unknown>,
  check = async (_capability: string): Promise<unknown> => ({ code: "granted" }),
) {
  const entitlement = mock(read)
  ;(window as unknown as { api: unknown }).api = {
    billing: {
      entitlement,
      check,
      checkout: async () => "https://checkout.example/pro",
      portal: async () => "https://billing.example/portal",
    },
  }
  return entitlement
}

async function mount() {
  const container = document.createElement("div")
  document.body.append(container)
  let snapshot!: Snapshot
  const dispose = render(() => {
    snapshot = owner!.useEntitlement()
    return createComponent(app!.WindowsAppMenu, {
      command: { options: [], keybind: () => undefined, trigger: () => undefined } as never,
      platform: platform as never,
    })
  }, container)
  cleanups.push(() => {
    dispose()
    container.remove()
  })
  await snapshot.reload()
  await settle()
  return { snapshot, container }
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
  row(en["desktop.menu.account"]).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
  await settle()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
})

describe.skipIf(isServer)("account menu refresh", () => {
  test("opening the menu reloads unconfigured billing after backend setup", async () => {
    let account = free
    const read = billing(async () => account)
    const view = await mount()
    expect(view.snapshot.account()?.billingConfigured).toBe(false)
    account = configured
    const before = read.mock.calls.length
    await openMenu(view.container)
    expect(read.mock.calls.length).toBe(before + 1)
    expect(view.snapshot.account()?.billingConfigured).toBe(true)
    expect(row(en["desktop.menu.upgradePro"]).hasAttribute("data-disabled")).toBe(false)
    expect(row(en["desktop.menu.upgradeBusiness"]).hasAttribute("data-disabled")).toBe(false)
    expect(row(en["desktop.menu.manageBilling"]).hasAttribute("data-disabled")).toBe(true)
    expect(document.body.textContent).not.toContain(en["desktop.billing.notConfigured"])
  })

  test("unconfigured billing disables upgrades even when the free tier is confirmed", async () => {
    billing(async () => free)
    const view = await mount()
    await openMenu(view.container)
    for (const key of [
      "desktop.menu.upgradePro",
      "desktop.menu.upgradeBusiness",
      "desktop.menu.manageBilling",
    ] as const)
      expect(row(en[key]).hasAttribute("data-disabled")).toBe(true)
    expect(row(en["desktop.billing.notConfigured"]).hasAttribute("data-disabled")).toBe(true)
  })

  test("an unavailable read explains disabled actions using existing translated copy", async () => {
    billing(async () => {
      throw new Error("unreachable")
    })
    const view = await mount()
    await openMenu(view.container)
    expect(row(en["desktop.billing.unreachable"]).hasAttribute("data-disabled")).toBe(true)
    expect(row(en["desktop.menu.upgradePro"]).hasAttribute("data-disabled")).toBe(true)
    expect(view.snapshot.account()).toBeUndefined()
  })

  test("focus refreshes sign-in and upgrade state with one shared focus subscription", async () => {
    let account: unknown = undefined
    const read = billing(async () => account)
    const view = await mount()
    account = configured
    const before = read.mock.calls.length
    window.dispatchEvent(new Event("focus"))
    await settle()
    expect(read.mock.calls.length).toBe(before + 1)
    expect(view.snapshot.account()?.plan).toBe("free")
    account = pro
    window.dispatchEvent(new Event("focus"))
    await settle()
    await openMenu(view.container)
    expect(row(en["desktop.menu.upgradePro"]).hasAttribute("data-disabled")).toBe(true)
    expect(row(en["desktop.menu.upgradeBusiness"]).hasAttribute("data-disabled")).toBe(false)
    expect(row(en["desktop.menu.manageBilling"]).hasAttribute("data-disabled")).toBe(false)
    cleanups.splice(0).forEach((cleanup) => cleanup())
    const stopped = read.mock.calls.length
    window.dispatchEvent(new Event("focus"))
    await settle()
    expect(read.mock.calls.length).toBe(stopped)
  })

  test("coalesces overlapping reloads and never publishes a superseded account", async () => {
    billing(async () => free)
    const view = await mount()
    const old = deferred<unknown>()
    const latest = deferred<unknown>()
    const read = billing(() => (read.mock.calls.length === 1 ? old.promise : latest.promise))
    const first = view.snapshot.reload()
    for (let i = 0; i < 20; i++) void view.snapshot.reload()
    expect(read.mock.calls.length).toBe(1)
    old.resolve(configured)
    await settle()
    expect(read.mock.calls.length).toBe(2)
    expect(view.snapshot.account()?.billingConfigured).toBe(false)
    latest.resolve(pro)
    await first
    expect(view.snapshot.account()?.plan).toBe("pro")
    expect(read.mock.calls.length).toBe(2)
  })

  test("a previous plan's pending capability answer cannot overwrite refreshed decisions", async () => {
    const old = deferred<unknown>()
    billing(
      async () => configured,
      () => old.promise,
    )
    const view = await mount()
    const pending = view.snapshot.check("cloud_vision")
    billing(async () => pro)
    await view.snapshot.reload()
    await view.snapshot.check("cloud_vision")
    old.resolve({ code: "not_entitled" })
    await pending
    await settle()
    expect(view.snapshot.decision("cloud_vision")?.code).toBe("granted")
  })
})
