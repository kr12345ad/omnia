import { plugin } from "bun"
import { createRequire } from "node:module"
import { realpathSync } from "node:fs"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { resolveTemplate } from "@solid-primitives/i18n"
import { createSignal } from "solid-js"
import { createComponent, isServer, render } from "solid-js/web"
import { dict as en } from "@/i18n/en"

// Bun has no Solid JSX transform, so the column under test goes through the same
// esbuild + babel-preset-solid pipeline the app build uses. The ui kit resolves
// to its sources, which bun transpiles with the app's `jsxImportSource`, exactly
// like the usage-limits harness.
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

const APP_SOURCE = /\/app\/src\/components\/shell-sidebar\.tsx$/
const UI_SOURCE = /\/packages\/ui\/src\/.*\.tsx(?:\?.*)?$/
// The ui kit is drawn from its sources, and those sources are Solid components:
// a copy bun compiles with its own (React) JSX runtime throws the moment one
// renders, so every ui component this column reaches is retagged into a copy
// this plugin compiles, exactly like the openui-design harness.
const UI_SPECIFIER = /(from\s*|import\s*)(["'])(@opencode-ai\/ui\/(?:v2\/[^"']+|spinner))\2/g
const ISOLATED = "shell-sidebar"

async function compile(path: string, source: string) {
  const local = createRequire(path)
  const stripped = await esbuild.transform(source, { loader: "tsx", jsx: "preserve" })
  const isolated = stripped.code.replace(UI_SPECIFIER, (match, prefix: string, quote: string, specifier: string) => {
    const resolved = local.resolve(specifier)
    if (!resolved.includes("/ui/src/") || !resolved.endsWith(".tsx")) return match
    return `${prefix}${quote}${resolved}?${ISOLATED}${quote}`
  })
  const result = await babel.transformAsync(isolated, {
    filename: path,
    presets: [[solidPreset, { generate: "dom", hydratable: false }]],
    configFile: false,
    babelrc: false,
    sourceMaps: false,
  })
  return result?.code ?? isolated
}

plugin({
  name: "shell-sidebar-solid-jsx-test",
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: "export default {}", loader: "js" }))
    build.onLoad({ filter: UI_SOURCE }, async (args) => ({
      contents: await compile(args.path.split("?")[0]!, await Bun.file(args.path.split("?")[0]!).text()),
      loader: "js",
    }))
    build.onLoad({ filter: APP_SOURCE }, async (args) => ({
      contents: await compile(args.path, await Bun.file(args.path).text()),
      loader: "js",
    }))
  },
})

// The column's dependencies are stubbed down to what it renders: a platform, a
// collapse signal, and an empty session list. Everything the test asserts is
// therefore the column's own behaviour, not a context's.
//
// Each stub replaces one hook and keeps the module's other exports real, because
// the column's own imports reach the same modules for server keys, layouts and
// route helpers; a stub carrying only the hook it replaces breaks them.
const [os, setOS] = createSignal<"macos" | "windows" | "linux" | undefined>("macos")
const [collapsed, setCollapsed] = createSignal(false)

mock.module("@/context/platform", () => ({
  usePlatform: () => ({
    platform: "desktop",
    get os() {
      return os()
    },
    openExternal: () => undefined,
  }),
}))

mock.module("@/context/language", () => ({
  useLanguage: () => ({
    locale: () => "en",
    intl: () => "en-US",
    t: (key: string, params?: Record<string, string | number | boolean>) => {
      const value = en[key as keyof typeof en]
      return value === undefined ? undefined : resolveTemplate(value, params)
    },
  }),
}))

mock.module("@/context/layout", () => ({
  useLayout: () => ({
    sidebar: {
      collapsed,
      setCollapsed,
      toggleCollapsed: () => setCollapsed((value) => !value),
    },
    projects: { list: () => [] },
  }),
}))

mock.module("@/context/server", () => ({
  RECENTLY_CLOSED_DISPLAY_LIMIT: 5,
  ServerConnection: { Key: { make: (key: string) => key } },
  useServer: () => ({ key: "local" }),
}))
mock.module("@/context/server-sync", () => ({
  useServerSync: () => () => ({ child: () => [{ session: {} }] }),
}))
mock.module("@/context/tabs", () => ({ useTabs: () => ({ newDraft: () => undefined }) }))
mock.module("@/context/notification", () => ({
  useNotification: () => ({ session: { unseenCount: () => 0, unseenHasError: () => false } }),
}))
mock.module("@/context/permission", () => ({ usePermission: () => ({ autoResponds: () => false }) }))
mock.module("@/context/global", () => ({
  useGlobal: () => ({ servers: { list: () => [] }, ensureServerCtx: () => ({ projects: { list: () => [] } }) }),
}))
// A footer row opens a settings page rather than a dialog the test would have to
// mount, so the page each row asks for is captured here.
const openedSettings: Array<string | undefined> = []
mock.module("@/components/settings-dialog", () => ({
  useSettingsDialog: (defaultValue?: string) => () => {
    openedSettings.push(defaultValue)
  },
}))
mock.module("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({ show: () => undefined, close: () => undefined }),
}))
mock.module("@/utils/toast", () => ({ showToast: () => undefined }))
mock.module("@/utils/session-route", () => ({ sessionHref: () => "/" }))
mock.module("@solidjs/router", () => ({ useParams: () => ({}), A: () => undefined }))

const { ShellSidebar } = isServer
  ? ({} as { ShellSidebar: never })
  : await import("@/components/shell-sidebar").catch((error: Error) => {
      console.error(error.stack)
      throw error
    })

const cleanups: (() => void)[] = []
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

async function mount() {
  setCollapsed(false)
  const container = document.createElement("div")
  document.body.append(container)
  const dispose = render(() => createComponent(ShellSidebar, {}), container)
  await settle()
  cleanups.push(() => {
    dispose()
    container.remove()
  })
  return container
}

/** The rows of the action column, in the order the column draws them. */
function actions(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLButtonElement>('[data-slot="shell-sidebar-action"]')]
}

function labels(container: HTMLElement) {
  return actions(container).map((action) => action.getAttribute("aria-label"))
}

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
})

describe("shell sidebar toggle", () => {
  test("macOS carries the toggle as the row above the new-session row and closes the column", async () => {
    setOS("macos")
    const container = await mount()

    expect(labels(container)[0]).toBe("Close Sidebar")
    expect(labels(container)[1]).toBe(en["command.session.new"])

    const toggle = actions(container)[0]!
    expect(toggle.querySelector('[data-slot="shell-sidebar-icon"]')?.innerHTML).toContain("svg")

    toggle.click()
    await settle()

    expect(collapsed()).toBe(true)
    expect(labels(container)[0]).toBe("Open Sidebar")
  })

  test("other platforms keep the toggle out of the column", async () => {
    setOS("windows")
    const container = await mount()

    expect(labels(container)[0]).toBe(en["command.session.new"])
    expect(labels(container)).not.toContain("Close Sidebar")
  })
})

describe("shell sidebar footer", () => {
  test("offers Settings, Chat Channels and Help, and Chat Channels opens its own page", async () => {
    setOS("windows")
    const container = await mount()
    const footer = container.querySelector<HTMLElement>('[data-slot="shell-sidebar-footer"]')
    expect(footer).not.toBeNull()
    const rows = [...footer!.querySelectorAll<HTMLButtonElement>('[data-slot="shell-sidebar-action"]')]
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      en["sidebar.settings"],
      en["settings.chatChannels.title"],
      en["sidebar.help"],
    ])
    // A row draws a real glyph: an unknown icon name silently falls back to the
    // plus icon, so an icon that does not exist still looks like an icon.
    expect(rows[1]!.querySelector('[data-slot="shell-sidebar-icon"]')?.innerHTML).toContain(
      "opencode-v2-icon-message",
    )

    openedSettings.length = 0
    rows[1]!.click()
    await settle()
    expect(openedSettings).toEqual(["chat-channels"])
  })
})
