import { plugin } from "bun"
import { createRequire } from "node:module"
import { realpathSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { flatten, resolveTemplate } from "@solid-primitives/i18n"
import { createComponent, isServer, render } from "solid-js/web"
import { Dialog as KobalteDialog } from "@kobalte/core/dialog"
import type { Config } from "@opencode-ai/sdk/v2/client"
import { dict as en } from "@/i18n/en"
import { dict as uiEn } from "@opencode-ai/ui/i18n/en"
import type { MarketplaceServer } from "@/mcp/marketplace"

// Bun has no Solid JSX transform, so the component under test and the ui kit it
// renders go through the same esbuild + babel-preset-solid pipeline the app build
// uses, exactly like the settings-account harness.
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
  name: "settings-mcp-marketplace-solid-jsx-test",
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: "export default {}", loader: "js" }))
    build.onLoad(
      {
        filter:
          /\/(ui\/src\/.*|app\/src\/components\/(settings-mcp-marketplace|settings-v2\/parts\/list))\.tsx(?:\?.*)?$/,
      },
      async (args) => {
        const path = args.path.split("?")[0]
        const stripped = await esbuild.transform(await Bun.file(path).text(), { loader: "tsx", jsx: "preserve" })
        const mine = path.endsWith("/app/src/components/settings-mcp-marketplace.tsx")
        const isolated =
          mine || args.path.includes("?marketplace-test")
            ? stripped.code.replace(
                /(from\s*|import\s*)(["'])([^"']+)\2/g,
                (match: string, prefix: string, quote: string, specifier: string) => {
                  if (
                    specifier.startsWith("@/context/") ||
                    specifier === "@/mcp/catalog" ||
                    specifier === "@opencode-ai/ui/context/dialog"
                  ) {
                    return `${prefix}${quote}${specifier}?marketplace-test${quote}`
                  }
                  if (specifier.startsWith("@opencode-ai/ui/") || specifier.startsWith(".")) {
                    const resolved = createRequire(path).resolve(specifier)
                    if (resolved.endsWith(".tsx")) return `${prefix}${quote}${resolved}?marketplace-test${quote}`
                  }
                  return match
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

const dictionary: Record<string, string> = flatten({ ...en, ...uiEn })
const translate = (key: string, params?: Record<string, string | number | boolean>) => {
  const value = dictionary[key]
  return value === undefined ? undefined : resolveTemplate(value, params)
}
mock.module(`${fromApp.resolve("@opencode-ai/ui/context/i18n")}?marketplace-test`, () => ({
  useI18n: () => ({
    locale: () => "en-US",
    layoutLocale: () => "en",
    t: translate,
    plural: (key: string) => dictionary[`${key}.other`],
  }),
}))

const FETCH: MarketplaceServer = {
  id: "com.example/fetch",
  name: "Fetch",
  description: "Fetches a URL and converts it to markdown",
  category: "search",
  command: ["docker", "run", "-i", "--rm", "mcp/fetch"],
  popularity: 1892674,
}

const GITHUB: MarketplaceServer = {
  id: "com.example/github",
  name: "GitHub",
  description: "Repositories, issues and pull requests",
  category: "devtools",
  command: ["npx", "-y", "@modelcontextprotocol/server-github"],
  env: [
    { name: "GITHUB_TOKEN", description: "Personal access token", secret: true },
    { name: "GITHUB_ORG", description: "Default organisation" },
  ],
}

let catalog: MarketplaceServer[] = [FETCH, GITHUB]
mock.module("@/mcp/catalog?marketplace-test", () => ({ loadCatalog: async () => catalog }))
mock.module("@/context/platform?marketplace-test", () => ({ usePlatform: () => ({ openExternal: mock() }) }))
mock.module("@/context/language?marketplace-test", () => ({
  useLanguage: () => ({
    locale: () => "en",
    intl: () => "en-US",
    layoutLocale: () => "en",
    t: translate,
    plural: (key: string) => dictionary[`${key}.other`],
  }),
}))

let config: Config = {}
const writes: Config[] = []
let writeError: string | undefined
mock.module("@/context/server-sync?marketplace-test", () => ({
  useServerSync: () => () => ({
    data: { config },
    updateConfig: async (next: Config) => {
      if (writeError) throw new Error(writeError)
      writes.push(next)
      config = next
    },
  }),
}))

const shown: (() => unknown)[] = []
const closed = mock()
mock.module("@opencode-ai/ui/context/dialog?marketplace-test", () => ({
  useDialog: () => ({
    show: (factory: () => unknown) => shown.push(factory),
    push: (factory: () => unknown) => shown.push(factory),
    close: closed,
  }),
}))

// Loaded after the plugin is registered: a static import of a ui module would be
// evaluated with bun's own JSX transform before this file's onLoad hooks exist.
const { SettingsMcpMarketplace } = isServer
  ? ({} as { SettingsMcpMarketplace: never })
  : await import("@/components/settings-mcp-marketplace?marketplace-test")

const cleanups: (() => void)[] = []
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

async function mount(factory: () => unknown) {
  const container = document.createElement("div")
  document.body.append(container)
  const dispose = render(() => factory() as never, container)
  cleanups.push(() => {
    dispose()
    container.remove()
  })
  await settle()
  await settle()
  return container
}

function button(container: HTMLElement, label: string) {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label)
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}

function rows(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>(".settings-v2-marketplace-row")]
}

function row(container: HTMLElement, name: string) {
  const found = rows(container).find((item) =>
    item.querySelector(".settings-v2-marketplace-name")?.textContent?.includes(name),
  )
  if (!found) throw new Error(`Missing row: ${name}`)
  return found
}

beforeEach(() => {
  config = {}
  writes.length = 0
  shown.length = 0
  closed.mockClear()
  catalog = [FETCH, GITHUB]
  writeError = undefined
})
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

describe.skipIf(isServer)("settings MCP marketplace", () => {
  test("lists the catalog with categories and installs a server that needs no settings", async () => {
    const container = await mount(() => createComponent(SettingsMcpMarketplace, {}))

    expect(container.textContent).toContain("MCP Marketplace")
    expect(container.textContent).toContain("2 servers")
    expect(row(container, "Fetch").textContent).toContain("Search & research")
    expect(row(container, "GitHub").textContent).toContain("Needs setup")

    button(row(container, "Fetch"), "Install").click()
    await settle()

    expect(writes).toHaveLength(1)
    expect(writes[0].mcp).toEqual({
      fetch: { type: "local", command: ["docker", "run", "-i", "--rm", "mcp/fetch"], enabled: true },
    })
    expect(shown).toHaveLength(0)
    expect(row(container, "Fetch").textContent).toContain("Installed")
  })

  test("collects declared settings before installing a server that needs them", async () => {
    const container = await mount(() => createComponent(SettingsMcpMarketplace, {}))
    button(row(container, "GitHub"), "Install").click()
    await settle()

    expect(writes).toHaveLength(0)
    expect(shown).toHaveLength(1)

    // The real dialog provider renders each stack entry inside a Kobalte dialog
    // root, which portals its content out of the mount container.
    await mount(() =>
      createComponent(KobalteDialog, {
        open: true,
        get children() {
          return shown[0]()
        },
      }),
    )
    const layers = document.body.querySelectorAll<HTMLElement>('[data-component="dialog-v2"]')
    const dialog = layers[layers.length - 1]
    const inputs = [...dialog.querySelectorAll<HTMLInputElement>("input")]
    expect(inputs.map((input) => input.type)).toEqual(["password", "text"])
    for (const [input, value] of [
      [inputs[0], "ghp_secret"],
      [inputs[1], "omnia"],
    ] as const) {
      input.value = value
      input.dispatchEvent(new Event("input", { bubbles: true }))
    }
    await settle()
    button(dialog, "Install").click()
    await settle()

    expect(writes).toHaveLength(1)
    expect(writes[0].mcp).toEqual({
      "modelcontextprotocol-server-github": {
        type: "local",
        command: ["npx", "-y", "@modelcontextprotocol/server-github"],
        environment: { GITHUB_TOKEN: "ghp_secret", GITHUB_ORG: "omnia" },
        enabled: true,
      },
    })
  })

  test("lists installed servers and turns startup loading off", async () => {
    config = { mcp: { fetch: { type: "local", command: FETCH.command, enabled: true } } }
    const container = await mount(() => createComponent(SettingsMcpMarketplace, {}))

    button(container, "Installed (1)").click()
    await settle()
    expect(container.textContent).toContain("Load on startup")
    const toggle = row(container, "fetch").querySelector<HTMLInputElement>('[data-slot="switch-input"]')
    expect(toggle).not.toBeNull()
    toggle!.click()
    await settle()

    expect(writes.at(-1)?.mcp?.fetch).toEqual({ type: "local", command: FETCH.command, enabled: false })
  })

  test("keeps a server the user added by hand, and removes the one they ask for", async () => {
    config = {
      mcp: {
        fetch: { type: "local", command: FETCH.command, enabled: true },
        hand: { type: "remote", url: "https://example.com/mcp" },
      },
    }
    const container = await mount(() => createComponent(SettingsMcpMarketplace, {}))

    button(container, "Installed (2)").click()
    await settle()
    expect(row(container, "hand").textContent).toContain("Added by you")
    button(row(container, "fetch"), "Remove").click()
    await settle()

    expect(writes.at(-1)?.mcp).toEqual({ hand: { type: "remote", url: "https://example.com/mcp" } })
  })

  test("filters by search text and by category", async () => {
    const container = await mount(() => createComponent(SettingsMcpMarketplace, {}))
    expect(rows(container)).toHaveLength(2)

    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!
    search.value = "github"
    search.dispatchEvent(new Event("input", { bubbles: true }))
    await settle()
    expect(rows(container)).toHaveLength(1)
    expect(rows(container)[0].textContent).toContain("GitHub")

    search.value = ""
    search.dispatchEvent(new Event("input", { bubbles: true }))
    await settle()
    button(container, "Search & research").click()
    await settle()
    expect(rows(container)).toHaveLength(1)
    expect(rows(container)[0].textContent).toContain("Fetch")
  })

  test("reaches every page and resets pagination when searching", async () => {
    catalog = Array.from({ length: 53 }, (_, index) => ({
      ...FETCH,
      id: `entry-${index}`,
      name: `Entry ${String(index).padStart(2, "0")}`,
      command: ["npx", "-y", `entry-${index}`],
      popularity: 53 - index,
    }))
    const container = await mount(() => createComponent(SettingsMcpMarketplace, {}))
    expect(rows(container)).toHaveLength(24)
    expect(container.textContent).toContain("Page 1 of 3")
    button(container, "Next").click()
    await settle()
    expect(container.textContent).toContain("Page 2 of 3")
    expect(rows(container)[0].textContent).toContain("Entry 24")
    button(container, "Last").click()
    await settle()
    expect(rows(container)).toHaveLength(5)
    expect(button(container, "Next").disabled).toBe(true)
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!
    search.value = "Entry 01"
    search.dispatchEvent(new Event("input", { bubbles: true }))
    await settle()
    expect(rows(container)).toHaveLength(1)
    expect(container.textContent).toContain("Page 1 of 1")
  })

  test("opens server details and returns to the same filtered results", async () => {
    const container = await mount(() => createComponent(SettingsMcpMarketplace, {}))
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!
    search.value = "github"
    search.dispatchEvent(new Event("input", { bubbles: true }))
    await settle()
    button(row(container, "GitHub"), "Details").click()
    await settle()
    expect(container.querySelector(".settings-v2-marketplace-details")?.textContent).toContain("GITHUB_TOKEN")
    expect(container.textContent).toContain("Requires Node.js and npx")
    expect(container.querySelector("pre")?.textContent).toContain("@modelcontextprotocol/server-github")
    button(container, "Back to results").click()
    await settle()
    expect(rows(container)).toHaveLength(1)
    expect(container.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("github")
  })

  test("filters the catalog by runtime", async () => {
    const container = await mount(() => createComponent(SettingsMcpMarketplace, {}))
    const select = container.querySelector<HTMLSelectElement>("select")!
    select.value = "docker"
    select.dispatchEvent(new Event("change", { bubbles: true }))
    await settle()
    expect(rows(container)).toHaveLength(1)
    expect(rows(container)[0].textContent).toContain("Fetch")
  })

  test("a refused installation keeps setup open and reports the server message", async () => {
    const container = await mount(() => createComponent(SettingsMcpMarketplace, {}))
    button(row(container, "GitHub"), "Install").click()
    await settle()
    await mount(() =>
      createComponent(KobalteDialog, {
        open: true,
        get children() {
          return shown[0]()
        },
      }),
    )
    const layers = document.body.querySelectorAll<HTMLElement>('[data-component="dialog-v2"]')
    const dialog = layers[layers.length - 1]
    const secret = dialog.querySelector<HTMLInputElement>('input[type="password"]')!
    secret.value = "keep-this-value"
    secret.dispatchEvent(new Event("input", { bubbles: true }))
    writeError = "The connected server could not save the MCP configuration."
    button(dialog, "Install").click()
    await settle()
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(writeError)
    expect(secret.value).toBe("keep-this-value")
    expect(closed).not.toHaveBeenCalled()
    expect(writes).toHaveLength(0)
  })

  test("required setup values are validated before any config write", async () => {
    catalog = [{ ...GITHUB, env: [{ name: "TOKEN", secret: true, required: true }] }]
    const container = await mount(() => createComponent(SettingsMcpMarketplace, {}))
    button(row(container, "GitHub"), "Install").click()
    await settle()
    await mount(() =>
      createComponent(KobalteDialog, {
        open: true,
        get children() {
          return shown[0]()
        },
      }),
    )
    const layers = document.body.querySelectorAll<HTMLElement>('[data-component="dialog-v2"]')
    const dialog = layers[layers.length - 1]
    button(dialog, "Install").click()
    await settle()
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("TOKEN")
    expect(writes).toHaveLength(0)
    expect(closed).not.toHaveBeenCalled()
  })
})
