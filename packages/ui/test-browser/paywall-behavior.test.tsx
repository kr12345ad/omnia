import { plugin } from "bun"
import { createRequire } from "node:module"
import { realpathSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { createComponent, isServer, render } from "solid-js/web"

// This suite renders the shipped component, so it needs a DOM before anything
// else is imported. The shim is the app package's dev dependency: borrowing that
// exact copy keeps one happy-dom in the workspace instead of a second one here.
if (typeof document === "undefined") {
  const fromApp = createRequire(new URL("../../app/package.json", import.meta.url))
  const registrator = (await import(pathToFileURL(fromApp.resolve("@happy-dom/global-registrator")).href)) as {
    GlobalRegistrator: { register(options?: unknown): void }
  }
  registrator.GlobalRegistrator.register()
}

// Bun has no Solid JSX transform, so the sources under test go through the same
// esbuild + babel-preset-solid pipeline the app build uses. Only the paywall
// surface and its own dependencies are transformed: nothing here is mocked, so
// the Button and Icon under test are the ones the app ships.
const here = createRequire(import.meta.url)
const fromVite = createRequire(realpathSync(here.resolve("vite")))
const fromVitePluginSolid = createRequire(realpathSync(here.resolve("vite-plugin-solid")))
const esbuild = fromVite("esbuild") as {
  transform(source: string, options: Record<string, unknown>): Promise<{ code: string }>
}
const babel = fromVitePluginSolid("@babel/core") as {
  transformAsync(source: string, options: Record<string, unknown>): Promise<{ code?: string } | null>
}
const solidPreset = fromVitePluginSolid("babel-preset-solid")

const UI_SOURCE = /\/ui\/src\/(components\/(paywall|button|icon)|context\/i18n)\.tsx$/

plugin({
  name: "paywall-behaviour-solid-jsx-test",
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

const paywall = isServer ? undefined : await import("../src/components/paywall")

type Decision = {
  code: "granted" | "limit_reached" | "not_entitled" | "unknown"
  metering?: "hard" | "soft"
  used?: number
  limit?: number
  reason?: string
}

type Offer = { plan?: string; price?: string; action?: string; onUpgrade?: () => void }

let upgraded = 0
let dismissed = 0

/** happy-dom reads the OS preference out of its own settings, as a browser would. */
function setReducedMotion(value: "reduce" | "no-preference") {
  ;(
    window as unknown as { happyDOM: { settings: { device: { prefersReducedMotion: string } } } }
  ).happyDOM.settings.device.prefersReducedMotion = value
}

/**
 * Mounts the real component. `offer: null` is the surface a caller renders when
 * it has nothing to sell, which is how the tone-only cases stay tone-only.
 */
function mount(props: { capability?: string; decision?: Decision; offer?: Offer | null; onDismiss?: () => void } = {}) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(
    () =>
      createComponent(paywall!.Paywall, {
        capability: props.capability ?? "remote_shell",
        get decision() {
          return props.decision
        },
        get offer() {
          if (props.offer === null) return undefined
          return {
            plan: "Pro",
            price: "$15 a month",
            onUpgrade: () => {
              upgraded += 1
            },
            ...props.offer,
          }
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

/** Fails loudly rather than throwing a null dereference twenty lines later. */
function rendered(app: ReturnType<typeof mount>) {
  const surface = app.surface()
  expect(surface).not.toBeNull()
  return surface as Element
}

/** The tone icon is real markup here, so its identity is a real symbol reference. */
function toneIcon(surface: Element) {
  return surface.querySelector("[data-slot=paywall-icon] use")?.getAttribute("href")
}

beforeEach(() => {
  upgraded = 0
  dismissed = 0
})

afterAll(() => {
  document.body.replaceChildren()
})

describe.skipIf(isServer)("paywall", () => {
  test("a granted capability renders nothing at all, not even a control", () => {
    const app = mount({ decision: { code: "granted", used: 12, limit: 300 }, onDismiss: () => undefined })

    expect(app.container.childNodes.length).toBe(0)
    expect(app.container.innerHTML).toBe("")
    expect(app.container.textContent).toBe("")
    expect(app.container.querySelectorAll("button").length).toBe(0)
    expect(app.container.querySelectorAll("[data-slot^=paywall-]").length).toBe(0)
    expect(app.surface()).toBeNull()
    app.unmount()
  })

  test("no decision has arrived yet, so nothing is claimed", () => {
    const app = mount({ onDismiss: () => undefined })

    expect(app.container.childNodes.length).toBe(0)
    expect(app.container.innerHTML).toBe("")
    expect(app.surface()).toBeNull()
    app.unmount()
  })

  test('an "unknown" decision renders nothing: an unreadable billing store is our outage, not a bill', () => {
    const app = mount({
      // Even carrying usage numbers and the server's own sentence about the
      // outage, the code means we do not know, so nothing is rendered.
      decision: { code: "unknown", used: 999, limit: 3, reason: "billing store unreachable" },
      onDismiss: () => undefined,
    })

    expect(app.container.childNodes.length).toBe(0)
    expect(app.container.innerHTML).toBe("")
    expect(app.container.textContent).toBe("")
    expect(app.container.querySelectorAll("button").length).toBe(0)
    expect(app.container.textContent).not.toContain("Billing")
    expect(app.surface()).toBeNull()
    app.unmount()
  })

  test("a soft limit is a notice that the feature still works, not an error", () => {
    const app = mount({ decision: { code: "limit_reached", metering: "soft", used: 300, limit: 300 }, offer: null })
    const surface = rendered(app)

    expect(surface.getAttribute("data-tone")).toBe("fair-use")
    expect(surface.getAttribute("role")).toBe("status")
    expect(surface.getAttribute("role")).not.toBe("alert")
    expect(surface.hasAttribute("aria-live")).toBe(false)
    expect(surface.getAttribute("aria-live")).not.toBe("assertive")

    expect(surface.querySelector("[data-slot=paywall-title]")!.textContent).toBe(
      "Remote shell is past its fair-use allowance",
    )
    expect(surface.querySelector("[data-slot=paywall-description]")!.textContent).toBe(
      "It still works. Upgrading raises the allowance.",
    )
    expect(surface.textContent).toContain("It still works")
    expect(surface.textContent).toContain("300 of 300 used this period")

    // A working feature wears a tick, never a warning or a ban, and the error
    // vocabulary is nowhere in the surface.
    expect(toneIcon(surface)).toBe("#opencode-icon-circle-check")
    expect(toneIcon(surface)).not.toBe("#opencode-icon-warning")
    expect(toneIcon(surface)).not.toBe("#opencode-icon-shield")
    expect(surface.outerHTML).not.toContain("circle-ban-sign")
    expect(surface.outerHTML).not.toContain("danger")
    // The glyph is decorative, so the meaning cannot rest on its shape.
    expect(surface.querySelector("[data-slot=paywall-icon]")!.getAttribute("aria-hidden")).toBe("true")

    // Nothing to sell, so nothing that pretends to sell: a notice about a
    // feature that still works carries no upgrade control.
    expect(surface.querySelectorAll("button").length).toBe(0)
    app.unmount()
  })

  test("a hard limit says the allowance is used up and never that it still works", () => {
    const app = mount({ decision: { code: "limit_reached", metering: "hard", used: 300, limit: 300 }, offer: null })
    const surface = rendered(app)

    expect(surface.getAttribute("data-tone")).toBe("used-up")
    expect(surface.getAttribute("role")).toBe("status")
    expect(surface.querySelector("[data-slot=paywall-title]")!.textContent).toBe(
      "The Remote shell allowance is used up",
    )
    expect(surface.textContent).not.toContain("It still works")
    expect(surface.textContent).not.toContain("fair-use allowance")
    expect(toneIcon(surface)).toBe("#opencode-icon-warning")
    expect(surface.querySelector("[data-slot=paywall-usage-text]")!.textContent).toBe("300 of 300 used this period")
    app.unmount()
  })

  test("a hard limit spent past the ceiling clamps the bar at 100% while the text tells the truth", () => {
    const app = mount({ decision: { code: "limit_reached", metering: "hard", used: 5000, limit: 3000 }, offer: null })
    const surface = rendered(app)

    const fill = surface.querySelector<HTMLElement>("[data-slot=paywall-usage-fill]")!
    expect(fill.style.width).toBe("100%")
    expect(surface.querySelector("[data-slot=paywall-usage-text]")!.textContent).toBe("5,000 of 3,000 used this period")
    app.unmount()
  })

  test("a fair-use allowance with no finite ceiling shows no bar rather than a fake one", () => {
    const app = mount({ decision: { code: "limit_reached", metering: "soft", used: 4200 }, offer: null })
    const surface = rendered(app)

    expect(surface.querySelector("[data-slot=paywall-usage]")).toBeNull()
    expect(surface.textContent).toContain("It still works")
    app.unmount()
  })

  test("the usage numbers are the server's own numbers, formatted for the locale and in order", () => {
    const app = mount({
      decision: { code: "limit_reached", metering: "soft", used: 1234, limit: 10000 },
      offer: null,
    })
    const surface = rendered(app)

    // Used first, limit second, thousands separated: swapping the two, or
    // dropping the formatter, both change this string.
    expect(surface.querySelector("[data-slot=paywall-usage-text]")!.textContent).toBe(
      "1,234 of 10,000 used this period",
    )
    expect(surface.querySelector<HTMLElement>("[data-slot=paywall-usage-fill]")!.style.width).toBe("12%")
    app.unmount()
  })

  test("the bar is decoration and the numbers are real text, so nothing here is colour-only", () => {
    const app = mount({ decision: { code: "limit_reached", metering: "soft", used: 250, limit: 300 }, offer: null })
    const surface = rendered(app)

    const track = surface.querySelector("[data-slot=paywall-usage-track]")!
    const fill = track.querySelector<HTMLElement>("[data-slot=paywall-usage-fill]")!
    const text = surface.querySelector("[data-slot=paywall-usage-text]")!

    expect(track.getAttribute("aria-hidden")).toBe("true")
    expect(fill.closest("[aria-hidden=true]")).toBe(track)
    expect(fill.style.width).toBe("83%")

    expect(text.textContent).toBe("250 of 300 used this period")
    expect(text.closest("[aria-hidden=true]")).toBeNull()
    expect(text.childNodes[0]?.nodeType).toBe(3)
    app.unmount()
  })

  test("a refused capability names the capability and the plan and offers a working upgrade", () => {
    const app = mount({ capability: "cloud_vision", decision: { code: "not_entitled" } })
    const surface = rendered(app)

    expect(surface.getAttribute("data-tone")).toBe("locked")
    expect(surface.getAttribute("role")).toBe("group")
    const title = surface.querySelector("[data-slot=paywall-title]")!
    expect(title.textContent).toBe("Cloud vision is not included in your plan")
    // Labelled by its own title, so a screen reader lands on the meaning.
    expect(surface.getAttribute("aria-labelledby")).toBe(title.id)
    expect(surface.querySelector("[data-slot=paywall-description]")!.textContent).toBe(
      "Upgrading to Pro adds Cloud vision.",
    )
    // A refused capability is not a working one: it must not borrow the fair-use
    // copy that says the feature still works.
    expect(surface.textContent).not.toContain("It still works")
    expect(surface.textContent).not.toContain("past its fair-use allowance")
    expect(surface.querySelector("[data-slot=paywall-price]")!.textContent).toBe("$15 a month")

    const upgrade = surface.querySelector<HTMLButtonElement>("[data-slot=paywall-upgrade]")!
    expect(upgrade.tagName).toBe("BUTTON")
    expect(upgrade.textContent).toBe("Upgrade")
    expect(upgrade.hasAttribute("disabled")).toBe(false)
    upgrade.click()
    expect(upgraded).toBe(1)
    app.unmount()
  })

  test("a refusal with no plan name falls back to generic copy instead of printing a blank", () => {
    const missing = mount({ decision: { code: "not_entitled" }, offer: { plan: undefined } })
    const text = rendered(missing).textContent ?? ""

    expect(text).toContain("Remote shell is not included in your plan")
    expect(text).toContain("A paid plan adds Remote shell.")
    expect(text).not.toContain("Upgrading to  adds")
    for (const placeholder of ["undefined", "null", "NaN", "{{", "}}"]) {
      expect(text).not.toContain(placeholder)
    }
    // Nothing to name a plan is not a reason to stop offering the upgrade.
    rendered(missing).querySelector<HTMLButtonElement>("[data-slot=paywall-upgrade]")!.click()
    expect(upgraded).toBe(1)
    missing.unmount()

    const blank = mount({ decision: { code: "not_entitled" }, offer: { plan: "" } })
    const blankText = rendered(blank).textContent ?? ""
    expect(blankText).toContain("A paid plan adds Remote shell.")
    expect(blankText).not.toContain("Upgrading to  adds")
    expect(blankText).not.toContain("undefined")
    blank.unmount()
  })

  test("the offer's own action label replaces the default one", () => {
    const app = mount({
      decision: { code: "not_entitled" },
      offer: { action: "See Pro pricing" },
      capability: "vault_login",
    })

    const upgrade = rendered(app).querySelector("[data-slot=paywall-upgrade]")!
    expect(upgrade.textContent).toBe("See Pro pricing")
    expect(upgrade.textContent).not.toContain("Upgrade")
    app.unmount()
  })

  test("a capability with no translated name is printed verbatim rather than guessed at", () => {
    const app = mount({ capability: "some_new_capability", decision: { code: "not_entitled" }, offer: null })
    const surface = rendered(app)

    expect(surface.querySelector("[data-slot=paywall-title]")!.textContent).toBe(
      "some_new_capability is not included in your plan",
    )
    expect(surface.textContent).not.toContain("undefined")
    app.unmount()
  })

  test("the dismiss control is a real named button that fires once, and only when it can", () => {
    const closable = mount({
      decision: { code: "limit_reached", metering: "soft", used: 300, limit: 300 },
      offer: null,
      onDismiss: () => undefined,
    })
    const surface = rendered(closable)
    const dismiss = surface.querySelector<HTMLButtonElement>("[data-slot=paywall-dismiss]")!

    expect(dismiss.tagName).toBe("BUTTON")
    expect(dismiss.getAttribute("aria-label")).toBe("Dismiss")
    // The only thing inside it is a decorative glyph, so the name has to be on
    // the control itself.
    expect(dismiss.querySelector("[data-slot=icon-svg]")!.getAttribute("aria-hidden")).toBe("true")
    dismiss.click()
    expect(dismissed).toBe(1)
    closable.unmount()

    const permanent = mount({ decision: { code: "limit_reached", metering: "soft", used: 300, limit: 300 }, offer: null })
    expect(rendered(permanent).querySelector("[data-slot=paywall-dismiss]")).toBeNull()
    permanent.unmount()
  })

  test("every action is a focusable button in DOM order", () => {
    const app = mount({
      decision: { code: "limit_reached", metering: "soft", used: 300, limit: 300 },
      onDismiss: () => undefined,
    })
    const surface = rendered(app)
    const buttons = [...surface.querySelectorAll("button")]

    expect(buttons.map((button) => button.getAttribute("data-slot"))).toEqual(["paywall-upgrade", "paywall-dismiss"])
    for (const button of buttons) {
      expect(button.tagName).toBe("BUTTON")
      expect(button.hasAttribute("disabled")).toBe(false)
      expect(button.hasAttribute("tabindex")).toBe(false)
      // Native buttons are 0 in the tab order; a div or a tabindex="-1" is not.
      expect(button.tabIndex).toBe(0)
    }
    app.unmount()
  })

  test("the surface takes no focus, traps none, and is not a dialog", () => {
    const app = mount({
      decision: { code: "limit_reached", metering: "soft", used: 300, limit: 300 },
      onDismiss: () => undefined,
    })
    const surface = rendered(app)
    const next = document.createElement("button")
    next.textContent = "the control the user was reaching for"
    document.body.appendChild(next)

    const upgrade = surface.querySelector<HTMLButtonElement>("[data-slot=paywall-upgrade]")!
    expect(document.activeElement).not.toBe(upgrade)

    upgrade.focus()
    expect(document.activeElement).toBe(upgrade)
    // Straight past it: no sentinel, no trap, no focus pulled back on the way out.
    next.focus()
    expect(document.activeElement).toBe(next)

    expect(surface.hasAttribute("aria-modal")).toBe(false)
    // The surface itself is not a tab stop, so Tab walks past the whole thing.
    expect(surface.hasAttribute("tabindex")).toBe(false)
    expect(document.querySelector("[aria-modal=true]")).toBeNull()
    expect(document.querySelector("[role=dialog]")).toBeNull()
    expect(document.querySelector("[data-component=dialog]")).toBeNull()
    expect(surface.querySelector("[inert]")).toBeNull()

    next.remove()
    app.unmount()
  })

  test("prefers-reduced-motion is reported and follows the preference while the surface is up", () => {
    setReducedMotion("reduce")
    // Stated so the assertion below cannot pass by the shim quietly not switching.
    expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true)
    const reduced = mount({ decision: { code: "limit_reached", metering: "soft", used: 300, limit: 300 }, offer: null })
    expect(rendered(reduced).getAttribute("data-reduced-motion")).toBe("true")

    setReducedMotion("no-preference")
    expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(false)
    const animated = mount({ decision: { code: "limit_reached", metering: "soft", used: 300, limit: 300 }, offer: null })
    expect(rendered(animated).getAttribute("data-reduced-motion")).toBe("false")

    // Live, not a value frozen at mount: the media query is still being read.
    setReducedMotion("reduce")
    window.dispatchEvent(new Event("resize"))
    expect(rendered(animated).getAttribute("data-reduced-motion")).toBe("true")
    expect(rendered(reduced).getAttribute("data-reduced-motion")).toBe("true")

    setReducedMotion("no-preference")
    reduced.unmount()
    animated.unmount()
  })

  test("the server's own sentence is rendered verbatim, ahead of our copy", () => {
    const reason = "Billing store unreadable, so nothing was charged. Try again after 14:00 UTC."

    const refusal = mount({ decision: { code: "not_entitled", reason } })
    const description = rendered(refusal).querySelector("[data-slot=paywall-description]")!
    const verbatim = description.querySelector("[data-slot=paywall-reason]")!
    // Byte-for-byte, and before our copy rather than instead of it.
    expect(verbatim.textContent).toBe(reason)
    expect(description.firstChild).toBe(verbatim)
    expect(description.textContent).toBe(`${reason}Upgrading to Pro adds Remote shell.`)
    refusal.unmount()

    const limit = mount({ decision: { code: "limit_reached", metering: "soft", used: 300, limit: 300, reason }, offer: null })
    const limitDescription = rendered(limit).querySelector("[data-slot=paywall-description]")!
    expect(limitDescription.querySelector("[data-slot=paywall-reason]")!.textContent).toBe(reason)
    expect(limitDescription.textContent).toBe(`${reason}It still works. Upgrading raises the allowance.`)
    limit.unmount()
  })

  test("a server-supplied value is inserted literally, never expanded on the way to the screen", () => {
    // `$&` and `$1` are replacement patterns, `{{...}}` is our own placeholder
    // syntax: none of them may be expanded once the value is inside the copy.
    const plan = "$& $1 {{capability}}"
    const refusal = mount({ capability: "credential_vault", decision: { code: "not_entitled" }, offer: { plan } })
    const description = rendered(refusal).querySelector("[data-slot=paywall-description]")!

    expect(description.textContent).toBe("Upgrading to $& $1 {{capability}} adds Credential vault.")
    expect(description.textContent).not.toContain("{{plan}}")
    refusal.unmount()

    const reason = "Retry later: $& {{plan}}"
    const outage = mount({ capability: "credential_vault", decision: { code: "not_entitled", reason }, offer: { plan } })
    expect(rendered(outage).querySelector("[data-slot=paywall-reason]")!.textContent).toBe(reason)
    outage.unmount()
  })
})