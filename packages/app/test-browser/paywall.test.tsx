import { plugin } from "bun"
import { createRequire } from "node:module"
import { realpathSync } from "node:fs"
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createComponent, insert, isServer, render } from "solid-js/web"

if (typeof document === "undefined") {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator")
  GlobalRegistrator.register()
}

// Bun has no Solid JSX transform, so transform the ui-kit sources under test
// with the same esbuild + babel-preset-solid pipeline the app build uses.
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
  name: "paywall-solid-jsx-test",
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
// first wins the module registry with Bun's own JSX handling. Substituting the
// two leaf dependencies keeps this file independent of the run order; both
// stand-ins render the real elements (a native <button>, an aria-hidden icon)
// so the accessibility assertions below still describe shipped behaviour.
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

const paywall = isServer ? undefined : await import("@opencode-ai/ui/paywall")

type Decision = {
  code: "granted" | "limit_reached" | "not_entitled" | "unknown"
  metering?: "hard" | "soft"
  used?: number
  limit?: number
}

let upgraded = 0
let dismissed = 0

function mount(props: {
  decision?: Decision
  capability?: string
  offer?: { plan?: string; price?: string; onUpgrade?: () => void }
  onDismiss?: () => void
}) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(
    () =>
      createComponent(paywall!.Paywall, {
        capability: props.capability ?? "remote_shell",
        get decision() {
          return props.decision
        },
        offer: {
          plan: "Pro",
          price: "$15 a month",
          onUpgrade: () => {
            upgraded += 1
          },
          ...props.offer,
        },
        onDismiss:
          props.onDismiss === undefined
            ? undefined
            : () => {
                dismissed += 1
                props.onDismiss?.()
              },
      }),
    container,
  )
  return {
    container,
    surface: () => container.querySelector("[data-component=paywall]"),
    unmount() {
      dispose()
      container.remove()
    },
  }
}

beforeEach(() => {
  upgraded = 0
  dismissed = 0
})

afterAll(() => {
  document.body.replaceChildren()
})

describe.skipIf(isServer)("paywall", () => {
  test("renders nothing at all when the capability is granted", () => {
    const app = mount({ decision: { code: "granted", used: 12, limit: 300 } })
    expect(app.container.childNodes.length).toBe(0)
    expect(app.container.textContent).toBe("")
    expect(app.container.querySelectorAll("button").length).toBe(0)
    app.unmount()
  })

  test("renders nothing when the decision is unknown, so a billing outage is not billed to the user", () => {
    const app = mount({ decision: { code: "unknown", used: 0, limit: 3 } })
    expect(app.container.childNodes.length).toBe(0)
    app.unmount()
  })

  test("renders nothing when no decision has arrived yet", () => {
    const app = mount({})
    expect(app.container.childNodes.length).toBe(0)
    app.unmount()
  })

  test("a soft limit is a notice that says the feature still works, not an error", () => {
    const app = mount({ decision: { code: "limit_reached", metering: "soft", used: 300, limit: 300 } })

    const surface = app.surface()
    expect(surface).not.toBeNull()
    expect(surface!.getAttribute("data-tone")).toBe("fair-use")
    // A polite live region, never an assertive alert.
    expect(surface!.getAttribute("role")).toBe("status")
    expect(surface!.getAttribute("aria-modal")).toBeNull()
    expect(surface!.hasAttribute("aria-live")).toBe(false)

    const text = surface!.textContent ?? ""
    expect(text).toContain("Remote shell is past its fair-use allowance")
    expect(text).toContain("It still works")
    expect(text).toContain("300 of 300 used this period")

    // The error vocabulary must not appear anywhere in the surface.
    expect(surface!.innerHTML).not.toContain("v2-state-fg-danger")
    expect(surface!.querySelector("[data-component=icon][name=circle-ban-sign]")).toBeNull()
    app.unmount()
  })

  test("a soft limit keeps the usage numbers visible and the bar decorative", () => {
    const app = mount({ decision: { code: "limit_reached", metering: "soft", used: 250, limit: 300 } })

    const usage = app.surface()!.querySelector("[data-slot=paywall-usage]")!
    expect(usage.querySelector("[data-slot=paywall-usage-text]")!.textContent).toBe("250 of 300 used this period")
    const track = usage.querySelector("[data-slot=paywall-usage-track]")!
    expect(track.getAttribute("aria-hidden")).toBe("true")
    const fill = track.querySelector<HTMLElement>("[data-slot=paywall-usage-fill]")
    expect(fill.style.width).toBe("83%")
    app.unmount()
  })

  test("a fair-use limit with no finite ceiling shows no usage bar", () => {
    const app = mount({ decision: { code: "limit_reached", metering: "soft", used: 4200 } })
    expect(app.surface()!.querySelector("[data-slot=paywall-usage]")).toBeNull()
    expect(app.surface()!.textContent).toContain("It still works")
    app.unmount()
  })

  test("a hard limit reads as a spent allowance rather than a failure", () => {
    const app = mount({ decision: { code: "limit_reached", metering: "hard", used: 3, limit: 3 } })
    expect(app.surface()!.getAttribute("data-tone")).toBe("used-up")
    expect(app.surface()!.textContent).toContain("The Remote shell allowance is used up")
    expect(app.surface()!.textContent).not.toContain("It still works")
    app.unmount()
  })

  test("not entitled explains what upgrading adds and offers the upgrade", () => {
    const app = mount({ decision: { code: "not_entitled", metering: "hard", used: 0, limit: 0 } })

    const surface = app.surface()!
    expect(surface.getAttribute("data-tone")).toBe("locked")
    expect(surface.getAttribute("role")).toBe("group")
    expect(surface.textContent).toContain("Remote shell is not included in your plan")
    expect(surface.textContent).toContain("Upgrading to Pro adds Remote shell")

    const upgrade = surface.querySelector<HTMLButtonElement>("[data-slot=paywall-upgrade]")
    expect(upgrade.tagName).toBe("BUTTON")
    expect(upgrade.textContent).toContain("Upgrade")
    expect(surface.textContent).toContain("$15 a month")
    upgrade.click()
    expect(upgraded).toBe(1)
    app.unmount()
  })

  test("not entitled stays honest when the response carries no plan name", () => {
    const app = mount({ decision: { code: "not_entitled" }, offer: { plan: undefined } })
    const text = app.surface()!.textContent ?? ""
    expect(text).toContain("Remote shell is not included in your plan")
    expect(text).toContain("A paid plan adds Remote shell")
    expect(text).not.toContain("undefined")
    app.unmount()
  })

  test("the group is labelled by its own title so a screen reader lands on the meaning", () => {
    const app = mount({ decision: { code: "not_entitled" } })
    const surface = app.surface()!
    const labelledBy = surface.getAttribute("aria-labelledby")!
    expect(labelledBy).not.toBe("")
    expect(surface.querySelector(`#${labelledBy}`)!.textContent).toContain("not included in your plan")
    app.unmount()
  })

  test("nothing steals focus and the actions stay in the tab order", () => {
    const app = mount({
      decision: { code: "limit_reached", metering: "soft", used: 300, limit: 300 },
      onDismiss: () => undefined,
    })

    const surface = app.surface()!
    surface.querySelector("[data-slot=paywall-upgrade]")!.focus()
    expect(document.activeElement).toBe(surface.querySelector("[data-slot=paywall-upgrade]"))

    const dismiss = surface.querySelector<HTMLButtonElement>("[data-slot=paywall-dismiss]")
    // Native buttons are tabbable, so this is a real control rather than a div.
    expect(dismiss.tagName).toBe("BUTTON")
    expect(dismiss.getAttribute("aria-label")).toBe("Dismiss")
    dismiss.click()
    expect(dismissed).toBe(1)

    // Not a dialog: no overlay, no focus trap, nothing hiding the rest of the page.
    expect(document.querySelector("[aria-modal=true]")).toBeNull()
    expect(document.body.querySelectorAll("[data-component=paywall]").length).toBe(1)
    app.unmount()
  })

  test("omits the dismiss control when the caller offers no way to dismiss", () => {
    const app = mount({ decision: { code: "limit_reached", metering: "soft", used: 300, limit: 300 } })
    expect(app.surface()!.querySelector("[data-slot=paywall-dismiss]")).toBeNull()
    app.unmount()
  })

  test("reports reduced motion so the surface never animates against the preference", () => {
    const app = mount({ decision: { code: "limit_reached", metering: "soft", used: 300, limit: 300 } })
    const surface = app.surface()!
    expect(surface.getAttribute("data-reduced-motion")).toBe(
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "true" : "false",
    )
    app.unmount()
  })

  test("names the capability from the billing id and falls back to the raw id", () => {
    const shell = mount({ capability: "remote_shell", decision: { code: "not_entitled" } })
    expect(shell.surface()!.textContent).toContain("Remote shell")
    shell.unmount()

    const unknownCapability = mount({ capability: "some_new_capability", decision: { code: "not_entitled" } })
    expect(unknownCapability.surface()!.textContent).toContain("some_new_capability")
    unknownCapability.unmount()
  })
})
