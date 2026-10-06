import { plugin } from "bun"
import { createRequire } from "node:module"
import { realpathSync } from "node:fs"
import { afterAll, describe, expect, mock, test } from "bun:test"
import { createComponent, insert, isServer, render } from "solid-js/web"

if (typeof document === "undefined") {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator")
  GlobalRegistrator.register()
}

// Bun has no Solid JSX transform, so the sources under test go through the same
// esbuild + babel-preset-solid pipeline the app build uses: the attachment strip
// and the ui-kit paywall it must never draw.
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
const APP_SOURCE = /\/app\/src\/components\/prompt-input\/image-attachments\.tsx$/

plugin({
  name: "attachment-vision-notice-solid-jsx-test",
  setup(build) {
    // Stylesheets carry no behaviour under test, and Bun cannot import CSS.
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: "export default {}", loader: "js" }))
    build.onLoad({ filter: new RegExp(`${UI_SOURCE.source}|${APP_SOURCE.source}`) }, async (args) => {
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

// The attachment strip's remaining leaves are decorative: a tooltip, a file-type
// card, an icon. Substituting them keeps this file independent of run order and
// of how heavy each real one is, while every stand-in renders real elements so
// the accessibility assertions below still describe shipped behaviour.
function element(tag: string, attributes: Record<string, string>) {
  return (props: { children?: unknown }) => {
    const node = document.createElement(tag)
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value)
    insert(node, () => props.children)
    return node
  }
}

mock.module("@opencode-ai/ui/icon", () => ({
  Icon: (props: { name?: string; size?: string; class?: string }) => {
    const icon = document.createElement("span")
    icon.setAttribute("data-component", "icon")
    icon.setAttribute("aria-hidden", "true")
    if (props.name) icon.setAttribute("name", props.name)
    return icon
  },
}))
mock.module("@opencode-ai/ui/v2/icon", () => ({
  Icon: (props: { name?: string; class?: string }) => {
    const icon = document.createElement("span")
    icon.setAttribute("data-component", "icon-v2")
    icon.setAttribute("aria-hidden", "true")
    if (props.name) icon.setAttribute("name", props.name)
    return icon
  },
}))
mock.module("@opencode-ai/ui/tooltip", () => ({ Tooltip: element("div", {}) }))
mock.module("@opencode-ai/ui/v2/tooltip-v2", () => ({ TooltipV2: element("div", {}) }))
mock.module("@opencode-ai/session-ui/v2/attachment-card-v2", () => ({
  AttachmentCardV2: element("div", { "data-component": "attachment-card-v2" }),
}))
mock.module("@opencode-ai/session-ui/v2/comment-card-v2", () => ({
  CommentCardV2: element("div", { "data-component": "comment-card-v2" }),
}))
mock.module("@opencode-ai/session-ui/message-file", () => ({
  typeLabel: (filename: string) => filename,
}))

const ui = isServer ? undefined : await import("@opencode-ai/ui/paywall")
const attachments = isServer ? undefined : await import("@/components/prompt-input/image-attachments")

type Decision = {
  code: "granted" | "limit_reached" | "not_entitled" | "unknown"
  metering?: "hard" | "soft"
  used?: number
  limit?: number
  reason?: string
}

/** The server's own sentence for a free-plan refusal of the vision fallback. */
const FREE_PLAN_REFUSAL: Decision = {
  code: "not_entitled",
  metering: "hard",
  reason: "cloud_vision is not included in the free plan.",
}

function mount(component: () => unknown) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(component as () => undefined, container)
  return {
    container,
    surface: () => container.querySelector("[data-component=paywall]"),
    unmount() {
      dispose()
      container.remove()
    },
  }
}

function screenshot() {
  return {
    type: "image" as const,
    id: "att_1",
    filename: "screenshot.png",
    mime: "image/png",
    blob: { id: "blob_1", url: "blob:screenshot" },
  }
}

/**
 * The attachment strip exactly as the composer renders it, including the
 * entitlement props it still supplies.
 */
function Strip(props: { decision?: Decision }) {
  return createComponent(attachments!.PromptImageAttachments, {
    attachments: [screenshot()],
    onOpen: () => undefined,
    onRemove: () => undefined,
    removeLabel: "Remove attachment",
    fileLabel: "File",
    newLayoutDesigns: false,
    get vision() {
      return props.decision
    },
    get visionOffer() {
      return { plan: "Pro", price: "$15 a month", onUpgrade: () => undefined }
    },
    onDismissVision: () => undefined,
  })
}

afterAll(() => {
  document.body.replaceChildren()
})

// An attached image is sent to the account's own model, so attaching one is free.
// cloud_vision is the vision-model FALLBACK in the computer-use path, which an
// attachment never enters, so a notice here was billing somebody for our own bug.
describe.skipIf(isServer)("attaching an image", () => {
  test("renders no paywall even when cloud_vision is refused outright", () => {
    const app = mount(() => createComponent(Strip, { decision: FREE_PLAN_REFUSAL }))

    expect(app.container.querySelector("[data-component=paywall]")).toBeNull()
    expect(app.container.textContent).not.toContain("not included in your plan")
    expect(app.container.textContent).not.toContain("Upgrade")
    app.unmount()
  })

  test("is never gated: the image and its remove control are still there", () => {
    const app = mount(() => createComponent(Strip, { decision: FREE_PLAN_REFUSAL }))

    const image = app.container.querySelector("img")!
    expect(image.getAttribute("alt")).toBe("screenshot.png")
    expect(image.getAttribute("src")).toBe("blob:screenshot")

    // A native button, so it is in the tab order and reachable without a pointer.
    const remove = app.container.querySelector<HTMLButtonElement>("button")!
    expect(remove.tagName).toBe("BUTTON")
    expect(remove.getAttribute("aria-label")).toBe("Remove attachment")
    remove.focus()
    expect(document.activeElement).toBe(remove)
    app.unmount()
  })

  test("renders no paywall for a pro account that is merely near its soft limit", () => {
    const app = mount(() =>
      createComponent(Strip, { decision: { code: "limit_reached", metering: "soft", used: 1999, limit: 2000 } }),
    )

    expect(app.container.querySelector("[data-component=paywall]")).toBeNull()
    expect(app.container.textContent).not.toContain("fair-use allowance")
    app.unmount()
  })
})

// The refusal is real, it is just not this surface's. Where it actually happens -
// the vision-model fallback in the computer-use service - the same decision does
// draw the notice, so the free action above is the only dishonest part.
describe.skipIf(isServer)("a genuine cloud_vision refusal", () => {
  function Notice(props: { decision?: Decision }) {
    return createComponent(ui!.Paywall, {
      capability: "cloud_vision",
      get decision() {
        return props.decision
      },
      offer: { plan: "Pro", price: "$15 a month", onUpgrade: () => undefined },
      onDismiss: () => undefined,
    })
  }

  test("is explained with the upgrade affordance where the capability is refused", () => {
    const app = mount(() => createComponent(Notice, { decision: FREE_PLAN_REFUSAL }))

    const surface = app.surface()!
    expect(surface.getAttribute("data-tone")).toBe("locked")
    expect(surface.getAttribute("role")).toBe("group")
    expect(surface.textContent).toContain("Cloud vision is not included in your plan")
    // The server's sentence wins, so this is the control plane explaining itself.
    expect(surface.textContent).toContain("cloud_vision is not included in the free plan.")
    expect(surface.querySelector<HTMLButtonElement>("[data-slot=paywall-upgrade]")!.tagName).toBe("BUTTON")
    app.unmount()
  })

  test("stays a working-feature notice on pro rather than becoming an error", () => {
    const app = mount(() =>
      createComponent(Notice, { decision: { code: "limit_reached", metering: "soft", used: 1999, limit: 2000 } }),
    )

    const surface = app.surface()!
    expect(surface.getAttribute("data-tone")).toBe("fair-use")
    expect(surface.getAttribute("role")).toBe("status")
    expect(surface.textContent).toContain("Cloud vision is past its fair-use allowance")
    expect(surface.textContent).toContain("It still works")
    expect(surface.getAttribute("data-reduced-motion")).toBe(
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "true" : "false",
    )
    app.unmount()
  })

  test("is silent once the plan does include cloud_vision", () => {
    const app = mount(() => createComponent(Notice, { decision: { code: "granted", used: 3, limit: 2000 } }))

    expect(app.container.childNodes.length).toBe(0)
    expect(app.container.textContent).toBe("")
    app.unmount()
  })
})
