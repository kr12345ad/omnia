import { plugin } from "bun"
import { createRequire } from "node:module"
import { realpathSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import { createComponent, render } from "solid-js/web"

if (typeof document === "undefined") {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator")
  GlobalRegistrator.register()
}

// Bun has no Solid JSX transform, so the generated-UI surface goes through the
// same esbuild + babel-preset-solid pipeline the app build uses.
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

const OPENUI_SOURCE = /\/packages\/session-ui\/src\/openui\/.*\.tsx(?:\?.*)?$/
const UI_SOURCE = /\/packages\/ui\/src\/.*\.tsx(?:\?.*)?$/
// `MarkDownRenderer` and `CodeBlock` delegate to the transcript's markdown
// renderer, which pulls in the highlighting worker. The design of generated UI
// does not depend on it, so it stands in as a plain text node here.
const MARKDOWN_SOURCE = /\/session-ui\/src\/components\/markdown\.tsx$/

/** Marks this suite's own copies of the ui kit, so no other suite's copy is reused. */
const ISOLATED = "openui-design"
const UI_SPECIFIER = /(from\s*|import\s*)(["'])(@opencode-ai\/ui\/[^"']+)\2/g

async function solid(path: string, source: string) {
  const stripped = await esbuild.transform(source, { loader: "tsx", jsx: "preserve" })
  const result = await babel.transformAsync(stripped.code, {
    filename: path,
    presets: [[solidPreset, { generate: "dom", hydratable: false }]],
    configFile: false,
    babelrc: false,
    sourceMaps: false,
  })
  return result?.code ?? stripped.code
}

plugin({
  name: "openui-design-solid-jsx-test",
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: "export default {}", loader: "js" }))
    build.onLoad({ filter: MARKDOWN_SOURCE }, () => ({
      contents: "export function Markdown(props) { return String(props.text ?? '') }",
      loader: "js",
    }))
    build.onLoad({ filter: OPENUI_SOURCE }, async (args) => {
      const path = args.path.split("?")[0]!
      const source = await Bun.file(path).text()
      // Retag the ui kit imports of this package's renderers so generated UI
      // reads a copy this plugin compiles. A shared copy is a trap: whichever
      // suite imports a ui source before any onLoad hook exists leaves it
      // compiled with bun's own (React) JSX runtime, and rendering it throws.
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
      return { contents: result?.code ?? isolated, loader: "js" }
    })
    build.onLoad({ filter: UI_SOURCE }, (args) =>
      Bun.file(args.path.split("?")[0]!)
        .text()
        .then((source) => solid(args.path.split("?")[0]!, source).then((code) => ({ contents: code, loader: "js" as const }))),
    )
  },
})

const { OpenUIRender } = await import("@opencode-ai/session-ui/openui/render")
// The fence splitter is plain TypeScript, so bun loads it directly: only the
// `.tsx` renderers need the Solid transform the plugin above provides.
const { splitOpenUISegments } = await import("@opencode-ai/session-ui/openui/fence")

function mount(code: string, onAction?: (message: string) => void) {
  const host = document.createElement("div")
  document.body.appendChild(host)
  render(() => createComponent(OpenUIRender, { code, onAction }), host)
  return host
}

/**
 * The legacy palette is still in the theme for older surfaces, but generated UI
 * must not use it: the transcript around it renders on v2 tokens, so a legacy
 * token here would be a card from a different design system.
 */
// Anchored at the start of a class token: `text-v2-text-text-muted` contains
// `text-text-muted`, which a substring match would flag.
const LEGACY_TOKEN =
  /^(?:bg|text|border|icon|outline|accent|ring|divide|shadow)-(?:surface|text|border|icon)(?:-|\[)/

const LITERAL_COLOR = /#[0-9a-fA-F]{3}|rgba?\(|hsla?\(|var\(--(?:text|surface|border|icon)-/

function classes(host: HTMLElement) {
  return [...host.querySelectorAll<HTMLElement>("*")].flatMap((element) => element.className.split(/\s+/))
}

describe("openui design foundation", () => {
  test("a generated report draws as app-native panels", () => {
    const host = mount(
      [
        "root = Stack([card])",
        'card = Card([header, chart, table, note])',
        'header = CardHeader("Weekly report", "Last 7 days")',
        "chart = BarChart(labels, [series])",
        'labels = ["Mon", "Tue", "Wed"]',
        'series = Series("Signups", [12, 18, 9])',
        "table = Table([region, revenue])",
        'region = Col("Region", ["EMEA", "APAC"])',
        'revenue = Col("Revenue", [120, 98], "number")',
        'note = Callout("info", "On track", "Revenue is up 8% week over week.")',
      ].join("\n"),
    )

    const card = host.querySelector<HTMLElement>('[data-component="openui-card"]')
    expect(card).not.toBeNull()
    // `PANEL_ELEVATED`: the surface, outline and elevation the app's own panels use.
    expect(card!.classList.contains("rounded-xl")).toBe(true)
    expect(card!.classList.contains("border-v2-border-border-muted")).toBe(true)
    expect(card!.classList.contains("bg-v2-background-bg-layer-01")).toBe(true)

    // The chart is framed as a panel, and the table as a comparison grid whose
    // first body row carries no rule under the header.
    expect(host.querySelector('[data-component="openui-bar-chart"]')).not.toBeNull()
    const table = host.querySelector<HTMLElement>('[data-component="openui-table"]')
    expect(table!.classList.contains("bg-v2-background-bg-layer-01")).toBe(true)
    const bodyRow = table!.querySelector<HTMLElement>("tbody tr")
    expect(bodyRow!.classList.contains("first:border-t-0")).toBe(true)

    // Confidence that the answer is not a paragraph in disguise.
    expect(host.querySelector('[data-slot="openui-card-title"]')!.textContent).toBe("Weekly report")
    expect(host.querySelector('[data-component="openui-callout"]')).not.toBeNull()
  })

  test("generated UI draws only on theme tokens", () => {
    const host = mount(
      [
        "root = Stack([card, table])",
        'card = Card([header, callout])',
        'header = CardHeader("Weekly report", "Last 7 days")',
        'callout = Callout("warning", "Watch", "Revenue is down 3% week over week.")',
        "table = Table([region, revenue])",
        'region = Col("Region", ["EMEA", "APAC"])',
        'revenue = Col("Revenue", [120, 98], "number")',
      ].join("\n"),
    )

    const rendered = classes(host)
    expect(rendered.filter((value) => LEGACY_TOKEN.test(value))).toEqual([])
    expect(rendered.filter((value) => LITERAL_COLOR.test(value))).toEqual([])
    expect(rendered.filter((value) => LITERAL_COLOR.test(host.innerHTML))).toEqual([])
  })

  test("a generated form is the app's own controls, and its buttons report a message", () => {
    const actions: string[] = []
    const host = mount(
      [
        "root = Stack([form])",
        'form = Form("signup", action, [email, plan, topics])',
        "action = Buttons([submit, more, link])",
        'submit = Button("Sign up", @ToAssistant("signed up"), "primary")',
        'more = Button("Tell me more")',
        'link = Button("Docs", Action([@OpenUrl("https://example.com")]))',
        'email = FormControl("Email", Input("email", "you@example.com", "email"), "We never share it.")',
        "plan = FormControl(\"Plan\", OptionCards(\"plan\", \"single\", [free, pro]))",
        'free = OptionCard("free", "Free", "For one person")',
        'pro = OptionCard("pro", "Pro", "For a team")',
        'topics = FormControl("Topics", Chips("topics", "multiple", [alpha]))',
        'alpha = ChipItem("alpha", "Alpha")',
      ].join("\n"),
      (message) => actions.push(message),
    )

    // The field is the app's control, not a bare input with a look of its own.
    expect(host.querySelector('[data-component="text-input-v2"]')).not.toBeNull()
    const option = host.querySelector<HTMLElement>('[data-component="openui-option-cards"] button')
    expect(option!.classList.contains("rounded-xl")).toBe(true)
    const chip = host.querySelector<HTMLElement>('[data-component="openui-chips"] button')
    expect(chip!.classList.contains("rounded-full")).toBe(true)
    expect(chip!.getAttribute("aria-pressed")).toBe("false")

    const buttons = [...host.querySelectorAll<HTMLButtonElement>('[data-component="openui-buttons"] [data-component="button-v2"]')]
    expect(buttons.map((button) => button.textContent)).toEqual(["Sign up", "Tell me more", "Docs"])
    // `@ToAssistant` carries the message; a button with no action sends its
    // label; an action this build cannot run stays inert rather than speaking.
    buttons.forEach((button) => button.click())
    expect(actions).toEqual(["signed up", "Tell me more"])
  })

  // The escape hatch from the component vocabulary: a document the model writes
  // itself. Its power comes from what the frame is not allowed to reach.
  test("a hand-drawn Html program runs sandboxed, seeded with the app's theme", async () => {
    const host = mount(
      [
        "root = Stack([doc])",
        'doc = Html("Orbit", "<!doctype html><html><head><title>Orbit</title></head><body><canvas></canvas></body></html>", 320)',
      ].join("\n"),
    )

    // The frame mounts once the document stops arriving: an iframe re-mounted on
    // every streaming delta would restart the page it is running.
    expect(host.querySelector('[data-slot="openui-html-loading"]')).not.toBeNull()
    await Bun.sleep(700)

    const frame = host.querySelector<HTMLIFrameElement>('[data-slot="openui-html-frame"]')
    expect(frame).not.toBeNull()
    // Scripts yes, same-origin no: the page may draw and fetch, and still cannot
    // reach the app, its storage, its cookies or its parent window.
    expect(frame!.getAttribute("sandbox")).toBe("allow-scripts")
    expect(frame!.style.height).toBe("320px")

    const srcdoc = frame!.getAttribute("srcdoc") ?? ""
    // The document the model wrote is what runs, with the theme bridge in front
    // of it — the frame cannot inherit the app's styles across an opaque origin.
    expect(srcdoc).toContain("<canvas")
    expect(srcdoc).toContain("data-openui-theme")
    expect(srcdoc).toContain("html,body{margin:0")
    expect(srcdoc.indexOf("data-openui-theme")).toBeLessThan(srcdoc.indexOf("<canvas"))
    expect(host.querySelector('[data-slot="openui-html-title"]')!.textContent).toBe("Orbit")
  })

  test("a hand-drawn Svg stays a drawing: executable markup goes, height is clamped", async () => {
    const host = mount(
      [
        "root = Stack([drawing])",
        `drawing = Svg("<svg viewBox='0 0 10 10' onload='alert(1)'><script>alert(1)</script><foreignObject></foreignObject><circle cx='5' cy='5' r='4'/></svg>", "Orbit", 40)`,
      ].join("\n"),
    )
    await Bun.sleep(50)

    const drawing = host.querySelector<HTMLElement>('[data-slot="openui-svg-drawing"]')
    expect(drawing).not.toBeNull()
    const markup = drawing!.innerHTML.toLowerCase()
    expect(markup).toContain("<svg")
    expect(markup).not.toContain("script")
    expect(markup).not.toContain("onload")
    expect(markup).not.toContain("foreignobject")
    // 40px would be a stamp on the answer: the drawing clamps to its minimum.
    expect(drawing!.style.height).toBe("160px")

    // Shapes are asserted in a real browser rather than here: happy-dom parses
    // `<svg>` in the HTML namespace, so DOMPurify drops every SVG child as
    // invalid, while Chromium keeps `<circle>` in the SVG namespace.
  })

  // The path a real answer takes: prose with a fenced program inside it. A model
  // that answers with a hand-drawn Html document has to get a frame, not forty
  // lines of source printed into the transcript.
  test("a fenced Html program in a message is drawn, not printed", async () => {
    const text = [
      "Here is the orbit as a real 3D scene you can drag.",
      "",
      "```openui-lang",
      "root = Stack([doc])",
      'doc = Html("Orbit", "<!doctype html><html><body><canvas></canvas></body></html>", 240)',
      "```",
      "",
      "Rotate it to see the far side.",
    ].join("\n")

    const segments = splitOpenUISegments(text, false)
    expect(segments.map((segment) => segment.kind)).toEqual(["markdown", "openui", "markdown"])

    // Blocks are rendered one at a time, the way the transcript draws a message:
    // prose as text, a fence through the generated-UI renderer. No JSX here —
    // bun compiles this file with its own transform, not the Solid one.
    const host = document.createElement("div")
    document.body.appendChild(host)
    for (const segment of segments) {
      if (segment.kind === "markdown") {
        host.appendChild(document.createTextNode(segment.text))
        continue
      }
      const block = document.createElement("div")
      host.appendChild(block)
      render(() => createComponent(OpenUIRender, { code: segment.code, streaming: segment.streaming }), block)
    }
    await Bun.sleep(700)

    // Drawn: the fence produced the sandboxed frame the document runs in.
    const frame = host.querySelector<HTMLIFrameElement>('[data-slot="openui-html-frame"]')
    expect(frame).not.toBeNull()
    expect(frame!.getAttribute("sandbox")).toBe("allow-scripts")
    expect((frame!.getAttribute("srcdoc") ?? "").length).toBeGreaterThan(0)

    // Not printed: neither the program nor its document leaks into the answer.
    expect(host.textContent).not.toContain("root = Stack")
    expect(host.textContent).not.toContain("<!doctype html>")

    // The prose on either side of the fence stays prose.
    expect(host.textContent).toContain("Here is the orbit as a real 3D scene you can drag.")
    expect(host.textContent).toContain("Rotate it to see the far side.")
  })

  test("a generated tab set is the app's segmented control", () => {
    const host = mount(
      [
        "root = Tabs([lineTab, barTab])",
        "lineTab = TabItem(\"line\", \"Line\", [chart])",
        "barTab = TabItem(\"bar\", \"Bar\", [chart])",
        "chart = LineChart(labels, [series])",
        'labels = ["Mon", "Tue"]',
        'series = Series("Signups", [1, 2])',
      ].join("\n"),
    )

    const list = host.querySelector<HTMLElement>('[role="tablist"]')
    expect(list!.classList.contains("bg-v2-background-bg-layer-01")).toBe(true)
    const tabs = [...host.querySelectorAll<HTMLElement>('[role="tab"]')]
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Line", "Bar"])
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true")
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("false")
  })
})
