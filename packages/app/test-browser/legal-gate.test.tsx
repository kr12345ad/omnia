import { plugin } from "bun"
import { createRequire } from "node:module"
import { realpathSync } from "node:fs"
import { afterAll, describe, expect, mock, test } from "bun:test"
import { createRenderEffect } from "solid-js"
import { createComponent, insert, isServer, render } from "solid-js/web"
import type { LegalStatus } from "@/context/platform"

// Bun has no Solid JSX transform, so the surface under test goes through the
// same esbuild + babel-preset-solid pipeline the app build uses. The platform
// context import is retagged so this file's stub cannot leak into the shared
// module registry that the other browser suites read.
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
  name: "legal-gate-solid-jsx-test",
  setup(build) {
    build.onLoad({ filter: /\/(app\/src\/components\/legal-gate)\.tsx(?:\?.*)?$/ }, async (args) => {
      const source = await Bun.file(args.path.split("?")[0]).text()
      const stripped = await esbuild.transform(source, { loader: "tsx", jsx: "preserve" })
      const isolated = stripped.code.replace(
        /(from\s*)(["'])(@\/context\/platform)\2/g,
        (_match: string, prefix: string, quote: string, specifier: string) =>
          `${prefix}${quote}${specifier}?legal-gate${quote}`,
      )
      const result = await babel.transformAsync(isolated, {
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

// Leaf stand-ins render the real elements (a native button with its disabled
// attribute, an inert logo), so the assertions below describe shipped behaviour
// without pulling the whole ui kit through Bun's own JSX handling.
mock.module("@opencode-ai/ui/logo", () => ({
  Logo: (props: { class?: string }) => {
    const logo = document.createElement("div")
    logo.setAttribute("data-component", "logo")
    if (props.class) logo.className = props.class
    return logo
  },
}))
mock.module("@opencode-ai/ui/v2/button-v2", () => ({
  ButtonV2: (props: {
    children?: unknown
    disabled?: boolean
    onClick?: () => void
    class?: string
    variant?: string
    size?: string
  }) => {
    const button = document.createElement("button")
    button.type = "button"
    if (props.class) button.className = props.class
    if (props.variant) button.setAttribute("data-variant", props.variant)
    if (props.size) button.setAttribute("data-size", props.size)
    createRenderEffect(() => {
      button.disabled = props.disabled === true
    })
    button.addEventListener("click", () => props.onClick?.())
    insert(button, () => props.children)
    return button
  },
}))
mock.module("@opencode-ai/ui/v2/loader-v2", () => ({
  LoaderV2: () => document.createElement("span"),
}))

const accepted: LegalStatus = {
  accepted: true,
  banned: false,
  bannedAt: null,
  sealed: false,
  fingerprint: "fp-1",
  version: "2026-10-20",
  reason: null,
  source: null,
}
const pending: LegalStatus = { ...accepted, accepted: false }
const banned: LegalStatus = {
  ...accepted,
  accepted: false,
  banned: true,
  bannedAt: Date.UTC(2026, 9, 1),
  sealed: true,
  reason: "Automated abuse of the computer-use tools",
}

type Calls = { accept: string[]; decline: number; refresh: number; external: string[] }

function fakeLegal(status: LegalStatus) {
  const calls: Calls = { accept: [], decline: 0, refresh: 0, external: [] }
  return {
    calls,
    status: async () => status,
    accept: async (version: string) => {
      calls.accept.push(version)
      return { ...status, accepted: true, version }
    },
    decline: () => void (calls.decline += 1),
    refresh: async () => {
      calls.refresh += 1
      return accepted
    },
    openExternal: (url: string) => void calls.external.push(url),
  }
}

// The stub is registered once, before the gate module is imported; each test
// swaps the implementation it points at, so the platform context stays a
// single module instance for the whole file.
let current = fakeLegal(pending)
mock.module("@/context/platform?legal-gate", () => ({
  usePlatform: () => ({ legal: current, openExternal: current.openExternal }),
}))

const { LegalGate } = isServer
  ? ({} as { LegalGate: never })
  : await import("@/components/legal-gate?legal-gate")

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function mount(legal: ReturnType<typeof fakeLegal>) {
  current = legal
  const container = document.createElement("div")
  document.body.appendChild(container)
  const child = document.createElement("div")
  child.setAttribute("data-testid", "app")
  child.textContent = "app"
  const dispose = render(() => createComponent(LegalGate, { get children() { return child } }), container)
  await settle()
  return {
    container,
    text: () => container.textContent ?? "",
    button: (label: string) =>
      [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(label)),
    unmount() {
      dispose()
      container.remove()
    },
  }
}

afterAll(() => {
  document.body.replaceChildren()
})

// happy-dom performs no layout, so a scroll container reports an empty viewport
// and no overflow until these metrics are supplied. The rule under test is the
// gate's scroll-to-end check, not the browser's own measurement.
function simulateOverflow() {
  const viewport = 400
  const content = 1000
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => viewport })
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => content })
  return () => {
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>
    delete proto.clientHeight
    delete proto.scrollHeight
  }
}

describe.skipIf(isServer)("legal gate", () => {
  test("terms block the app until the reader reaches the end and agrees", async () => {
    const restore = simulateOverflow()
    try {
      const legal = fakeLegal(pending)
      const surface = await mount(legal)
      expect(surface.text()).toContain("Terms of Service")
      expect(surface.container.querySelector('[data-testid="app"]')).toBeNull()
      expect(surface.text()).toContain("Scroll to the end of the Terms to continue.")
      const agree = surface.button("I agree")
      expect(agree?.disabled).toBe(true)

      // Reaching the end unlocks the button; only then does agreeing record the
      // version and hand control to the app.
      const body = surface.container.querySelector('[data-slot="terms-body"]') as HTMLDivElement
      body.scrollTop = body.scrollHeight
      body.dispatchEvent(new Event("scroll"))
      await settle()
      expect(surface.text()).toContain("By selecting I agree, you accept these Terms.")
      expect(surface.button("I agree")?.disabled).toBe(false)

      surface.button("I agree")?.click()
      await settle()
      expect(legal.calls.accept).toEqual(["2026-10-20"])
      expect(surface.container.querySelector('[data-testid="app"]')).not.toBeNull()
      surface.unmount()
    } finally {
      restore()
    }
  })

  test("declining quits instead of accepting", async () => {
    const legal = fakeLegal(pending)
    const surface = await mount(legal)
    surface.button("Decline and quit")?.click()
    await settle()
    expect(legal.calls.decline).toBe(1)
    expect(legal.calls.accept).toEqual([])
    expect(surface.container.querySelector('[data-testid="app"]')).toBeNull()
    surface.unmount()
  })

  test("a banned installation shows the reason, fingerprint and encrypted state", async () => {
    const legal = fakeLegal(banned)
    const surface = await mount(legal)
    expect(surface.container.querySelector('[data-testid="app"]')).toBeNull()
    expect(surface.text()).toContain("This installation is banned")
    expect(surface.text()).toContain("Automated abuse of the computer-use tools")
    expect(surface.text()).toContain("fp-1")
    // Sessions are sealed, never deleted: the screen says so, and the appeal
    // path is available without any network.
    expect(surface.text()).toContain("Sessions encrypted")
    expect(surface.text()).toContain("Your sessions and settings have not been deleted")

    surface.button("Appeal by email")?.click()
    await settle()
    const appeal = legal.calls.external[0]
    expect(appeal?.startsWith("mailto:")).toBe(true)
    expect(decodeURIComponent(appeal ?? "")).toContain("fp-1")
    surface.unmount()
  })

  test("checking again re-runs the ban check and restores the app when lifted", async () => {
    const legal = fakeLegal(banned)
    const surface = await mount(legal)
    surface.button("Check again")?.click()
    await settle()
    expect(legal.calls.refresh).toBe(1)
    expect(surface.container.querySelector('[data-testid="app"]')).not.toBeNull()
    surface.unmount()
  })

  test("an accepted installation renders the app with no gate", async () => {
    const legal = fakeLegal(accepted)
    const surface = await mount(legal)
    expect(surface.container.querySelector('[data-testid="app"]')).not.toBeNull()
    expect(surface.text()).not.toContain("Terms of Service")
    surface.unmount()
  })
})
