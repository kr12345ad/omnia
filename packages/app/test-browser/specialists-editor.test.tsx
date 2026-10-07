import { plugin } from "bun"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { realpathSync } from "node:fs"
import { flatten, resolveTemplate } from "@solid-primitives/i18n"
import { createEffect } from "solid-js"
import { createComponent, insert, isServer, render } from "solid-js/web"
import type { Specialist, SpecialistRoster, SpecialistsPlatform } from "@/context/platform"
import { dict as en } from "@/i18n/en"
import { dict as uiEn } from "@opencode-ai/ui/i18n/en"

const local = createRequire(import.meta.url)
const vite = createRequire(realpathSync(local.resolve("vite")))
const solid = createRequire(realpathSync(local.resolve("vite-plugin-solid")))
plugin({
  name: "specialists-editor-solid",
  setup(build) {
    build.onLoad({ filter: /\/app\/src\/components\/specialists-editor\.tsx(?:\?.*)?$/ }, async (args) => {
      const path = args.path.split("?")[0]
      const fileRequire = createRequire(path)
      const stripped = await vite("esbuild").transform(await Bun.file(path).text(), { loader: "tsx", jsx: "preserve" })
      const isolated = stripped.code.replace(
        /(from\s*|import\s*)(["'])([^"']+)\2/g,
        (match: string, prefix: string, quote: string, specifier: string) => {
          const tag = (target: string) => `${prefix}${quote}${target}?specialists-editor${quote}`
          if (
            specifier === "@/context/entitlement" ||
            specifier === "@/context/language" ||
            specifier === "@/context/platform"
          ) return tag(specifier)
          if (!specifier.startsWith("@opencode-ai/ui/")) return match
          const resolved = fileRequire.resolve(specifier)
          if (!resolved.includes("/ui/src/") || !resolved.endsWith(".tsx")) return match
          return `${prefix}${quote}${resolved}?specialists-editor${quote}`
        },
      )
      const result = await solid("@babel/core").transformAsync(isolated, {
        filename: path,
        presets: [[solid("babel-preset-solid"), { generate: "dom", hydratable: false }]],
        configFile: false,
        babelrc: false,
      })
      return { contents: result.code, loader: "js" }
    })
  },
})

const dictionary: Record<string, string> = flatten({ ...en, ...uiEn })
const copy = (key: string, params?: Record<string, string | number>) =>
  resolveTemplate(dictionary[key], params)
const t = (key: string, params?: Record<string, string | number>) =>
  copy(`work.home.discussion.specialists.${key}`, params)

let specialists: SpecialistsPlatform | undefined
let billingConfigured = false
const checkouts: string[] = []
const platform = { get specialists() { return specialists } }
mock.module("@/context/platform?specialists-editor", () => ({ usePlatform: () => platform }))
mock.module("@/context/language?specialists-editor", () => ({
  useLanguage: () => ({ t: copy, intl: () => "en-US" }),
}))
mock.module("@/context/entitlement?specialists-editor", () => ({
  useEntitlement: () => ({ account: () => ({ billingConfigured }) }),
  checkoutPlan: (_platform: unknown, _language: unknown, plan: string) => {
    checkouts.push(plan)
    return Promise.resolve(true)
  },
}))

type ButtonProps = {
  children?: unknown
  disabled?: boolean
  onClick?: () => void
  onBlur?: () => void
  "aria-expanded"?: boolean
  "aria-controls"?: string
  "aria-label"?: string
  "data-slot"?: string
}
function button(props: ButtonProps) {
  const element = document.createElement("button")
  element.type = "button"
  if (props["data-slot"]) element.setAttribute("data-slot", props["data-slot"])
  createEffect(() => {
    element.disabled = props.disabled === true
    if (props["aria-label"]) element.setAttribute("aria-label", props["aria-label"])
    if (props["aria-controls"]) element.setAttribute("aria-controls", props["aria-controls"])
    if (props["aria-expanded"] !== undefined) element.setAttribute("aria-expanded", String(props["aria-expanded"]))
  })
  element.addEventListener("click", () => props.onClick?.())
  element.addEventListener("blur", () => props.onBlur?.())
  insert(element, () => props.children)
  return element
}
mock.module(`${local.resolve("@opencode-ai/ui/button")}?specialists-editor`, () => ({ Button: button }))
mock.module(`${local.resolve("@opencode-ai/ui/icon-button")}?specialists-editor`, () => ({ IconButton: button }))
mock.module(`${local.resolve("@opencode-ai/ui/text-field")}?specialists-editor`, () => ({
  TextField: (props: {
    label?: string
    value?: string
    description?: string
    error?: string
    disabled?: boolean
    multiline?: boolean
    onChange?: (value: string) => void
  }) => {
    const wrapper = document.createElement("div")
    const input = document.createElement(props.multiline ? "textarea" : "input")
    const description = document.createElement("span")
    const error = document.createElement("span")
    input.setAttribute("aria-label", props.label ?? "")
    description.setAttribute("data-slot", "input-description")
    error.setAttribute("data-slot", "input-error")
    input.addEventListener("input", () => props.onChange?.(input.value))
    createEffect(() => {
      input.value = props.value ?? ""
      input.disabled = props.disabled === true
      input.setAttribute("aria-invalid", props.error === undefined ? "false" : "true")
      description.textContent = props.description ?? ""
      error.textContent = props.error ?? ""
    })
    wrapper.append(input, description, error)
    return wrapper
  },
}))
mock.module(`${local.resolve("@opencode-ai/ui/paywall")}?specialists-editor`, () => ({
  Paywall: (props: { capability: string; decision?: { code: string }; offer?: { onUpgrade?: () => void } }) => {
    const surface = document.createElement("div")
    surface.setAttribute("data-component", "paywall")
    surface.setAttribute("role", "group")
    surface.setAttribute("data-capability", props.capability)
    surface.setAttribute("data-decision", props.decision?.code ?? "")
    const title = document.createElement("span")
    title.textContent = copy("ui.paywall.locked.title", { capability: copy("ui.paywall.capability.customSpecialists") })
    surface.append(title)
    if (props.offer?.onUpgrade) {
      const upgrade = button({ "data-slot": "paywall-upgrade", children: copy("ui.paywall.upgrade"), onClick: props.offer.onUpgrade })
      surface.append(upgrade)
    }
    return surface
  },
}))

const { SpecialistsEditor } = isServer
  ? ({} as { SpecialistsEditor: never })
  : await import("@/components/specialists-editor?specialists-editor")
const defaults: readonly Specialist[] = [
  { role: "strategist", name: "Strategist", focus: "Goals and tradeoffs" },
  { role: "builder", name: "Builder", focus: "Feasibility" },
  { role: "researcher", name: "Researcher", focus: "Evidence" },
  { role: "critic", name: "Critic", focus: "Risks" },
]
const limits = { minCount: 2, maxCount: 6, maxNameLength: 40, maxFocusLength: 800 }
const roster = (input: Partial<SpecialistRoster> = {}): SpecialistRoster => ({
  entitled: true,
  custom: false,
  specialists: defaults,
  defaults,
  limits,
  ...input,
})
const saves: (readonly Specialist[])[] = []
let resets = 0
let current = roster()
let saveResult: (input: readonly Specialist[]) => Promise<SpecialistRoster> = async (input) =>
  roster({ custom: true, specialists: input })
const api: SpecialistsPlatform = {
  get: async () => current,
  save: (input) => { saves.push(input); return saveResult(input) },
  reset: async () => { resets++; return roster() },
}
const cleanups: (() => void)[] = []
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
function mount(onCount?: (count: number | undefined) => void) {
  const container = document.createElement("div")
  document.body.append(container)
  const dispose = render(() => createComponent(SpecialistsEditor, { onCount }), container)
  cleanups.push(() => { dispose(); container.remove() })
  const named = (name: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === name) as HTMLButtonElement | undefined
  const open = () => (named(t("customize")) ?? named(t("view")))?.click()
  const fields = () => [...container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-slot="specialists-list"] input, [data-slot="specialists-list"] textarea')]
  const change = (index: number, value: string) => {
    const input = fields()[index]
    if (!input) throw new Error(`Missing field ${index}`)
    input.value = value
    input.dispatchEvent(new Event("input", { bubbles: true }))
  }
  return { container, named, open, fields, change }
}
beforeEach(() => {
  specialists = api
  billingConfigured = false
  checkouts.length = 0
  saves.length = 0
  resets = 0
  current = roster()
  saveResult = async (input) => roster({ custom: true, specialists: input })
})
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
  specialists = undefined
  billingConfigured = false
})

describe.skipIf(isServer)("specialists editor", () => {
  test("renders nothing without the specialists bridge", async () => {
    specialists = undefined
    const counts: (number | undefined)[] = []
    const view = mount((count) => counts.push(count))
    await settle()
    expect(view.container.querySelector('[data-component="specialists-editor"]')).toBeNull()
    expect(view.container.textContent).toBe("")
    expect(counts).toEqual([undefined])
  })

  test("shows loading, then the saved roster and its count", async () => {
    let finish: (value: SpecialistRoster) => void = () => undefined
    specialists = { ...api, get: () => new Promise((resolve) => { finish = resolve }) }
    const counts: (number | undefined)[] = []
    const view = mount((count) => counts.push(count))
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe(t("loading"))
    finish(roster())
    await settle()
    expect(view.container.textContent).toContain(t("title"))
    expect(view.container.textContent).toContain("Strategist")
    expect(counts).toEqual([undefined, 4])
    view.open()
    expect(view.container.querySelectorAll("[data-row]")).toHaveLength(4)
  })

  test("adds and removes only within the server limits", async () => {
    const view = mount()
    await settle()
    view.open()
    for (let index = 0; index < 2; index++) view.named(t("add"))?.click()
    expect(view.container.querySelectorAll("[data-row]")).toHaveLength(6)
    expect(view.named(t("add"))?.disabled).toBe(true)
    expect(view.container.textContent).toContain(t("maxHint", { max: 6 }))
    for (let index = 0; index < 4; index++) {
      view.container.querySelector<HTMLButtonElement>(`[aria-label="${t("remove", { index: 1 })}"]`)?.click()
    }
    expect(view.container.querySelectorAll("[data-row]")).toHaveLength(2)
    expect(view.container.querySelector<HTMLButtonElement>(`[aria-label="${t("remove", { index: 1 })}"]`)?.disabled).toBe(true)
    expect(view.container.querySelector<HTMLButtonElement>(`[aria-label="${t("remove", { index: 2 })}"]`)?.disabled).toBe(true)
    expect(view.container.textContent).toContain(t("minHint", { min: 2 }))
  })

  test("counts trimmed input, reports inline errors and refuses invalid saves", async () => {
    const view = mount()
    await settle()
    view.open()
    view.change(0, "  ")
    expect(view.container.textContent).toContain(t("nameRequired"))
    expect(view.container.textContent).toContain(t("counter", { used: 0, max: 40 }))
    view.change(0, "BUILDER")
    expect(view.container.textContent).toContain(t("nameDuplicate"))
    view.change(0, "manager")
    expect(view.container.textContent).toContain(t("nameReserved"))
    view.change(0, "  Planner  ")
    view.change(1, "  Plan the work  ")
    expect(view.container.textContent).toContain(t("counter", { used: 7, max: 40 }))
    expect(view.container.textContent).toContain(t("counter", { used: 13, max: 800 }))
    view.change(1, " ")
    expect(view.container.textContent).toContain(t("focusRequired"))
    view.named(t("save"))?.click()
    expect(view.container.textContent).toContain(t("invalid"))
    expect(saves).toHaveLength(0)
  })

  test("tracks unsaved changes and preserves roles only for unchanged names", async () => {
    const counts: (number | undefined)[] = []
    const view = mount((count) => counts.push(count))
    await settle()
    view.open()
    expect(view.named(t("save"))?.disabled).toBe(true)
    expect(view.container.querySelector('[data-slot="specialists-unsaved"]')).toBeNull()
    view.change(1, "  A different focus  ")
    expect(view.container.textContent).toContain(t("unsaved"))
    expect(view.container.textContent).toContain(t("unsavedHint"))
    view.change(1, defaults[0].focus)
    expect(view.container.querySelector('[data-slot="specialists-unsaved"]')).toBeNull()
    view.change(0, "  Planner  ")
    view.named(t("add"))?.click()
    view.change(8, "Newcomer")
    view.change(9, "New focus")
    expect(counts.at(-1)).toBe(4)
    view.named(t("save"))?.click()
    await settle()
    expect(saves).toHaveLength(1)
    expect(saves[0]).toEqual([
      { role: "", name: "Planner", focus: defaults[0].focus },
      defaults[1], defaults[2], defaults[3],
      { role: "", name: "Newcomer", focus: "New focus" },
    ])
    expect(view.container.querySelector('[data-slot="specialists-unsaved"]')).toBeNull()
    expect(view.named(t("save"))?.disabled).toBe(true)
    expect(view.container.textContent).toContain(t("saved"))
    expect(counts.at(-1)).toBe(5)
  })

  test("shows a rejected save's server message verbatim and keeps edits unsaved", async () => {
    const message = "The server refused these specialists: keep the original roster."
    saveResult = async () => { throw new Error(message) }
    const view = mount()
    await settle()
    view.open()
    view.change(1, "New focus")
    view.named(t("save"))?.click()
    await settle()
    expect(saves).toHaveLength(1)
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(message)
    expect(view.container.textContent).toContain(t("unsaved"))
    expect(view.named(t("save"))?.disabled).toBe(false)
  })

  test("resets local edits immediately but requires a second click to reset a saved custom roster", async () => {
    const view = mount()
    await settle()
    view.open()
    view.change(1, "Edited")
    view.named(t("reset"))?.click()
    expect(view.fields()[1].value).toBe(defaults[0].focus)
    expect(resets).toBe(0)
    view.change(1, "Edited again")
    view.named(t("save"))?.click()
    await settle()
    view.named(t("reset"))?.click()
    expect(view.named(t("resetConfirm"))).toBeDefined()
    expect(resets).toBe(0)
    view.named(t("resetConfirm"))?.click()
    await settle()
    expect(resets).toBe(1)
    expect(view.container.querySelectorAll("[data-row]")).toHaveLength(4)
    expect(view.fields()[1].value).toBe(defaults[0].focus)
  })

  test("free users see read-only defaults and a non-blocking paywall without checkout when billing is unavailable", async () => {
    current = roster({ entitled: false })
    const counts: (number | undefined)[] = []
    const view = mount((count) => counts.push(count))
    await settle()
    view.open()
    expect(view.container.textContent).toContain(t("defaultsNote"))
    expect(view.container.querySelectorAll('[data-slot="specialists-defaults"] li')).toHaveLength(4)
    expect(view.container.textContent).toContain(defaults[0].focus)
    expect(view.container.querySelector('[data-slot="specialists-list"]')).toBeNull()
    expect(view.named(t("add"))).toBeUndefined()
    expect(view.named(t("save"))).toBeUndefined()
    expect(view.container.querySelector('[data-component="paywall"]')?.getAttribute("data-capability")).toBe("custom_specialists")
    expect(view.container.querySelector('[data-component="paywall"]')?.getAttribute("data-decision")).toBe("not_entitled")
    expect(view.container.textContent).toContain(copy("ui.paywall.capability.customSpecialists"))
    expect(view.container.querySelector('[data-slot="paywall-upgrade"]')).toBeNull()
    expect(counts).toEqual([undefined])
    expect(view.named(t("hide"))).toBeDefined()
    expect(checkouts).toEqual([])
  })

  test("offers checkout only when billing is configured and leaves the roster visible", async () => {
    billingConfigured = true
    current = roster({ entitled: false })
    const view = mount()
    await settle()
    view.open()
    view.container.querySelector<HTMLButtonElement>('[data-slot="paywall-upgrade"]')?.click()
    expect(checkouts).toEqual(["pro"])
    expect(view.container.querySelector('[data-slot="specialists-defaults"]')).not.toBeNull()
    expect(view.named(t("hide"))).toBeDefined()
  })
})
