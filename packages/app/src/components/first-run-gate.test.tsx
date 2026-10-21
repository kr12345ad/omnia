import { plugin } from "bun"
import { createRequire } from "node:module"
import { realpathSync } from "node:fs"
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createComponent, insert, isServer, render } from "solid-js/web"

if (typeof document === "undefined") {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator")
  GlobalRegistrator.register()
}

// Bun has no Solid JSX transform, so transform the component sources here with
// the same esbuild + babel-preset-solid pipeline the app build uses. The
// modules under test are imported dynamically after the plugin is registered.
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
  name: "solid-jsx-test",
  setup(build) {
    build.onLoad({ filter: /(first-run-gate|github-auth)\.tsx$/ }, async (args) => {
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

// The gate pulls in the v2 UI kit and app contexts that are irrelevant here;
// substitute the narrow surfaces it reads so the blocking logic can be driven
// like the real renderer would.
mock.module("@opencode-ai/ui/v2/button-v2", () => ({
  ButtonV2: (props: {
    children?: unknown
    disabled?: boolean
    onClick?: () => void
    type?: "button" | "submit" | "reset"
  }) => {
    const button = document.createElement("button")
    button.type = props.type ?? "button"
    button.disabled = props.disabled === true
    button.addEventListener("click", () => props.onClick?.())
    insert(button, () => props.children)
    return button
  },
}))
mock.module("@opencode-ai/ui/v2/loader-v2", () => ({
  LoaderV2: () => {
    const loader = document.createElement("span")
    loader.setAttribute("data-testid", "loader")
    return loader
  },
}))
mock.module("@opencode-ai/ui/logo", () => ({
  Logo: () => document.createElementNS("http://www.w3.org/2000/svg", "svg"),
}))
mock.module("@opencode-ai/ui/icon", () => ({ Icon: () => null }))
mock.module("@opencode-ai/ui/dropdown-menu", () => ({ DropdownMenu: () => null }))
mock.module("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
// Outside a managed build the enterprise policy stays undefined, so the public
// gate is unchanged by this mock.
mock.module("@/context/enterprise", () => ({
  useEnterprise: () => ({ policy: () => undefined, managed: false }),
}))

type TestStatus = {
  authenticated: boolean
  profile?: { id: number; login: string; name?: string }
  controlPlaneUrl?: string
}

const state = {
  status: { authenticated: false } as TestStatus,
  signInResult: { authenticated: true, profile: { id: 1, login: "octocat" } } as TestStatus,
  signInError: undefined as Error | undefined,
  signInProviders: [] as (string | undefined)[],
  managed: false,
  enterpriseSignIns: [] as { identifier: string; password: string }[],
}

const enterpriseProfile = {
  kind: "omnia-enterprise-client",
  schema: 1,
  distribution: "acme-field",
  version: "1.0.0",
  name: "Acme Field",
  appId: "io.omnia.enterprise.acme-field",
  server: "http://10.0.0.4:8787",
  manifestUrl: "http://10.0.0.4:8787/v1/enterprise/public/client/acme-field/manifest",
  loginUrl: "http://10.0.0.4:8787/v1/enterprise/public/client/acme-field/login",
  org: { name: "Acme", slug: "acme" },
  branding: {
    productName: "Acme Field",
    shortName: "AF",
    tagline: "Field work, on your infrastructure.",
    primaryColor: "#0a0a0a",
    accentColor: "#2563eb",
    signInHeadline: "Sign in to Acme Field",
    showOmniaBranding: false,
  },
  auth: { allowedEmailDomains: ["acme.test"] },
  features: {},
  experience: {},
  update: {},
  deployment: {},
}

const enterpriseAuth = {
  managed: true,
  profile: async () => enterpriseProfile,
  manifest: async () => undefined,
  policy: async () => undefined,
  signIn: async (identifier: string, password: string) => {
    state.enterpriseSignIns.push({ identifier, password })
    state.status = state.signInResult
    return state.status
  },
}

const platform = {
  platform: "desktop",
  openExternal: () => undefined,
  restart: async () => undefined,
  notify: async () => undefined,
  auth: {
    status: async () => state.status,
    signIn: async (provider?: string) => {
      state.signInProviders.push(provider)
      if (state.signInError !== undefined) throw state.signInError
      state.status = state.signInResult
      return state.status
    },
    signOut: async () => {
      state.status = { authenticated: false }
      return state.status
    },
    get enterprise() {
      return state.managed ? enterpriseAuth : undefined
    },
  },
}

mock.module("@/context/platform", () => ({ usePlatform: () => platform }))

const gateModule = isServer ? undefined : await import("./first-run-gate")
const authModule = isServer ? undefined : await import("./github-auth")

function mountGate() {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const app = document.createElement("div")
  app.setAttribute("data-testid", "app")
  app.textContent = "app content"
  const dispose = render(
    () =>
      createComponent(gateModule!.FirstRunGate, {
        get children() {
          return app
        },
      }),
    container,
  )
  return {
    container,
    unmount() {
      dispose()
      container.remove()
    },
  }
}

async function settle() {
  for (const _ of [0, 0, 0]) await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  state.status = { authenticated: false }
  state.signInError = undefined
  state.signInProviders = []
  state.managed = false
  state.enterpriseSignIns = []
})

afterAll(() => {
  document.body.replaceChildren()
})

describe.skipIf(isServer)("first-run gate", () => {
  test("blocks the app until signed in", async () => {
    const app = mountGate()
    await settle()

    expect(app.container.querySelector("[data-testid=app]")).toBeNull()
    const gate = app.container.querySelector("[data-component=first-run-gate]")
    expect(gate).not.toBeNull()
    expect(gate!.textContent).toContain("ui.github.signInTitle")
    expect(gate!.textContent).toContain("ui.github.continue")
    expect(gate!.textContent).toContain("ui.google.continue")
    expect(app.container.querySelectorAll("button").length).toBe(2)
    app.unmount()
  })

  test("reveals the app when a session already exists", async () => {
    state.status = { authenticated: true, profile: { id: 1, login: "octocat" } }
    const app = mountGate()
    await settle()

    expect(app.container.querySelector("[data-testid=app]")).not.toBeNull()
    expect(app.container.querySelector("[data-component=first-run-gate]")).toBeNull()
    app.unmount()
  })

  test("signs in through the gate and reveals the app", async () => {
    const app = mountGate()
    await settle()

    const buttons = app.container.querySelectorAll("button")
    expect(buttons.length).toBe(2)
    buttons[1]!.click()
    await settle()

    expect(state.signInProviders).toEqual(["google"])
    expect(state.status.authenticated).toBe(true)
    expect(app.container.querySelector("[data-testid=app]")).not.toBeNull()
    expect(app.container.querySelector("[data-component=first-run-gate]")).toBeNull()
    app.unmount()
  })

  test("shows an error when sign-in fails", async () => {
    state.signInError = new Error("The control plane is unreachable.")
    const app = mountGate()
    await settle()

    app.container.querySelectorAll("button")[0]!.click()
    await settle()

    expect(app.container.querySelector("[data-testid=app]")).toBeNull()
    expect(app.container.textContent).toContain("The control plane is unreachable.")
    app.unmount()
  })

  test("returns to the gate when the session signs out", async () => {
    state.status = { authenticated: true, profile: { id: 1, login: "octocat" } }
    const app = mountGate()
    await settle()
    expect(app.container.querySelector("[data-testid=app]")).not.toBeNull()

    await platform.auth.signOut()
    authModule!.notifyGitHubAuthChanged()
    await settle()

    expect(app.container.querySelector("[data-testid=app]")).toBeNull()
    expect(app.container.querySelector("[data-component=first-run-gate]")).not.toBeNull()
    app.unmount()
  })

  test("renders the distribution's client preview with no social sign-in", async () => {
    state.managed = true
    const app = mountGate()
    await settle()

    const gate = app.container.querySelector("[data-component=first-run-gate]")
    expect(gate).not.toBeNull()
    expect(gate!.textContent).toContain("Acme Field")
    expect(gate!.textContent).toContain("Sign in to Acme Field")
    expect(gate!.textContent).toContain("SSO only · acme.test")
    expect(gate!.textContent).toContain("Powered by your team")
    expect(gate!.textContent).not.toContain("ui.github.continue")
    expect(gate!.textContent).not.toContain("ui.google.continue")
    expect(app.container.querySelector("[data-testid=app]")).toBeNull()
    app.unmount()
  })

  test("signs in with the work account through the tenant server", async () => {
    state.managed = true
    const app = mountGate()
    await settle()

    const inputs = app.container.querySelectorAll("input")
    expect(inputs.length).toBe(2)
    inputs[0]!.value = "ada@acme.test"
    inputs[0]!.dispatchEvent(new Event("input", { bubbles: true }))
    inputs[1]!.value = "correct horse"
    inputs[1]!.dispatchEvent(new Event("input", { bubbles: true }))
    app.container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await settle()

    expect(state.enterpriseSignIns).toEqual([{ identifier: "ada@acme.test", password: "correct horse" }])
    expect(app.container.querySelector("[data-testid=app]")).not.toBeNull()
    expect(app.container.querySelector("[data-component=first-run-gate]")).toBeNull()
    app.unmount()
  })
})

describe.skipIf(isServer)("account label", () => {
  test("names a tenant session a work account instead of GitHub", () => {
    const work = { authenticated: true, method: "enterprise" as const, profile: { id: 1, login: "ada@acme.test" } }
    expect(authModule!.accountKind(work, true)).toBe("work")
    // Sessions written before the method existed are work accounts in a tenant build.
    expect(
      authModule!.accountKind({ authenticated: true, profile: { id: 1, login: "ada@acme.test" } }, true),
    ).toBe("work")
    expect(
      authModule!.accountKind({ authenticated: true, method: "oauth", profile: { id: 1, login: "octocat" } }, true),
    ).toBe("github")
    expect(
      authModule!.accountKind({ authenticated: true, method: "gh", profile: { id: 1, login: "octocat" } }, false),
    ).toBe("gh")
    expect(
      authModule!.accountKind(
        { authenticated: true, method: "oauth", profile: { id: "2", login: "ada", provider: "google" } },
        false,
      ),
    ).toBe("google")
  })
})
