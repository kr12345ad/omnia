import { plugin } from "bun"
import { createRequire } from "node:module"
import { realpathSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { afterAll, describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
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

// Bun has no Solid JSX transform, so the source under test goes through the same
// esbuild + babel-preset-solid pipeline the app build uses. Nothing here is
// mocked: the component under test is the one the app ships.
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

plugin({
  name: "text-reveal-behaviour-solid-jsx-test",
  setup(build) {
    // Stylesheets carry no behaviour under test, and Bun cannot import CSS.
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: "export default {}", loader: "js" }))
    build.onLoad({ filter: /\/ui\/src\/components\/text-reveal\.tsx$/ }, async (args) => {
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

const reveal = isServer ? undefined : await import("../src/components/text-reveal")

const HOLD = 30
/** The non-breaking space the leaving slot renders when there is nothing to wipe. */
const EMPTY_SLOT = "\u00A0"

function mount(initial: string) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const [text, setText] = createSignal(initial)
  const dispose = render(
    () =>
      createComponent(reveal!.TextReveal, {
        get text() {
          return text()
        },
        swapHold: HOLD,
        duration: 100,
      }),
    container,
  )
  const slot = (name: string) => container.querySelector(`[data-slot=text-reveal-${name}]`)?.textContent
  return {
    setText,
    swapping: () => container.querySelector("[data-component=text-reveal]")?.getAttribute("data-swapping") === "true",
    entering: () => slot("entering"),
    leaving: () => slot("leaving"),
    unmount() {
      dispose()
      container.remove()
    },
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
/** Long enough for the wiped-out text to be cleared before the next change lands. */
const pastWindow = () => sleep(HOLD * 3)

afterAll(() => {
  document.body.replaceChildren()
})

describe.skipIf(isServer)("TextReveal", () => {
  test("a change inside the hold window updates the text without restaging the wipe", async () => {
    const app = mount("Alpha")
    await pastWindow()
    expect(app.swapping()).toBe(false)

    app.setText("Beta")
    expect(app.swapping()).toBe(true)
    expect(app.leaving()).toBe("Alpha")

    // Three deltas inside the window. Each must land in the entering slot while
    // the text being wiped stays the one that was leaving when the wipe began: a
    // value rewritten this fast would otherwise re-stage it on every delta, which
    // is the flicker a streaming thinking heading used to show.
    app.setText("Gamma")
    app.setText("Delta")
    app.setText("Epsilon")
    expect(app.swapping()).toBe(true)
    expect(app.leaving()).toBe("Alpha")
    expect(app.entering()).toBe("Epsilon")
    app.unmount()
  })

  test("a change after the window starts a fresh wipe rather than being swallowed", async () => {
    const app = mount("Alpha")
    await pastWindow()

    app.setText("Beta")
    expect(app.swapping()).toBe(true)
    await pastWindow()
    expect(app.swapping()).toBe(false)

    app.setText("Gamma")
    expect(app.swapping()).toBe(true)
    // The wipe stages the value that was showing, not the first one this
    // component ever saw: the hold is a window, not a permanent mute.
    expect(app.leaving()).toBe("Beta")
    expect(app.entering()).toBe("Gamma")
    app.unmount()
  })

  test("a value that extends the current text grows in place instead of wiping", async () => {
    const app = mount("Heading")
    await pastWindow()
    expect(app.swapping()).toBe(false)

    app.setText("Heading and then some")
    expect(app.swapping()).toBe(false)
    expect(app.entering()).toBe("Heading and then some")
    expect(app.leaving()).toBe(EMPTY_SLOT)
    app.unmount()
  })
})
