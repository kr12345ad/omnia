import { plugin } from "bun"
import { createRequire } from "node:module"
import { realpathSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { flatten, resolveTemplate } from "@solid-primitives/i18n"
import { createComponent, isServer, render } from "solid-js/web"
import { dict as en } from "@/i18n/en"
import { dict as uiEn } from "@opencode-ai/ui/i18n/en"
import type { ChatChannelInput, ChatChannelSummary, ChatPlatformSpec } from "@/chat"

// Bun has no Solid JSX transform, so the panel under test and the ui kit it
// renders go through the same esbuild + babel-preset-solid pipeline the app
// build uses, exactly like the settings-account and marketplace harnesses.
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
  name: "settings-chat-channels-solid-jsx-test",
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: "export default {}", loader: "js" }))
    build.onLoad(
      {
        filter: /\/(ui\/src\/.*|app\/src\/components\/settings-chat-channels)\.tsx(?:\?.*)?$/,
      },
      async (args) => {
        const path = args.path.split("?")[0]
        const stripped = await esbuild.transform(await Bun.file(path).text(), { loader: "tsx", jsx: "preserve" })
        const mine = path.endsWith("/app/src/components/settings-chat-channels.tsx")
        // Only this suite's copies carry the tag, so the contexts and ui files
        // it resolves are its own and nobody else's mocks apply to it.
        const isolated =
          mine || args.path.includes("?chat-test")
            ? stripped.code.replace(
                /(from\s*|import\s*)(["'])([^"']+)\2/g,
                (match: string, prefix: string, quote: string, specifier: string) => {
                  if (specifier.startsWith("@/context/") || specifier === "@/chat") {
                    return `${prefix}${quote}${specifier}?chat-test${quote}`
                  }
                  if (specifier.startsWith("@opencode-ai/ui/") || specifier.startsWith(".")) {
                    const resolved = createRequire(path).resolve(specifier)
                    if (resolved.endsWith(".tsx")) return `${prefix}${quote}${resolved}?chat-test${quote}`
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

// Real dictionaries, so the copy this suite asserts on is shipped copy.
const dictionary: Record<string, string> = flatten({ ...en, ...uiEn })
const translate = (key: string, params?: Record<string, string | number | boolean>) => {
  const value = dictionary[key]
  return value === undefined ? undefined : resolveTemplate(value, params)
}
mock.module(`${fromApp.resolve("@opencode-ai/ui/context/i18n")}?chat-test`, () => ({
  useI18n: () => ({
    locale: () => "en-US",
    layoutLocale: () => "en",
    t: translate,
    plural: (key: string) => dictionary[`${key}.other`],
  }),
}))
mock.module("@/context/language?chat-test", () => ({
  useLanguage: () => ({
    locale: () => "en",
    intl: () => "en-US",
    t: translate,
  }),
}))

const SLACK: ChatPlatformSpec = {
  id: "slack",
  name: "Slack",
  description: "Mentions and subscribed threads",
  polling: false,
  fields: [{ key: "botToken", label: "Bot token", secret: true, required: true }],
  webhookPath: "/v1/chat/slack/webhook",
  docs: "https://example.test/slack",
}

const TELEGRAM: ChatPlatformSpec = {
  id: "telegram",
  name: "Telegram",
  description: "Private chats and groups",
  polling: true,
  fields: [
    { key: "botToken", label: "Bot token", secret: true, required: true },
    { key: "webhookSecret", label: "Webhook secret", secret: true, required: false },
  ],
  webhookPath: "/v1/chat/telegram/webhook",
  docs: "https://example.test/telegram",
}

const connects: ChatChannelInput[] = []
const disconnects: string[] = []
const toggles: Array<[string, boolean]> = []
let channels: ChatChannelSummary[] = []
// A server built before these routes existed answers every call with this.
let listError: string | undefined

const chat = {
  platforms: async () => [SLACK, TELEGRAM],
  list: async () => {
    if (listError !== undefined) throw new Error(listError)
    return channels
  },
  connect: async (input: ChatChannelInput) => {
    connects.push(input)
    const saved: ChatChannelSummary = {
      platform: input.platform,
      enabled: true,
      configured: Object.keys(input.credentials),
    }
    channels = [...channels.filter((item) => item.platform !== saved.platform), saved]
    return saved
  },
  disconnect: async (platform: string) => {
    disconnects.push(platform)
    const before = channels.length
    channels = channels.filter((item) => item.platform !== platform)
    return channels.length < before
  },
  setEnabled: async (platform: string, enabled: boolean) => {
    toggles.push([platform, enabled])
    const found = channels.find((item) => item.platform === platform)
    if (found === undefined) return undefined
    channels = channels.map((item) => (item.platform === platform ? { ...found, enabled } : item))
    return channels.find((item) => item.platform === platform)
  },
}

mock.module("@/context/platform?chat-test", () => ({
  usePlatform: () => ({ chat }),
}))

// The entitlement answer is what the panel gates on, so the suite drives it the
// way the server would: an explicit refusal, an explicit grant, or no answer.
let entitlement: unknown = undefined
mock.module("@/context/entitlement?chat-test", () => ({
  useEntitlement: () => ({
    account: () => entitlement,
    reload: () => Promise.resolve(),
    offer: () => undefined,
    check: () => Promise.resolve(undefined),
    decision: () => undefined,
    dismissed: () => false,
    dismiss: () => undefined,
  }),
}))

function account(chatChannels: { allowed: boolean; code: string } | undefined, plan: string) {
  return {
    billingConfigured: true,
    plan,
    monthlyUsd: 0,
    computers: 5,
    capabilities: chatChannels === undefined ? {} : { chat_channels: { ...chatChannels, used: 0, limit: null } },
  }
}

const { SettingsChatChannels } = isServer
  ? ({} as { SettingsChatChannels: never })
  : await import("@/components/settings-chat-channels?chat-test")

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

async function mount() {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(() => createComponent(SettingsChatChannels, {}), container)
  await settle()
  return {
    container,
    text: () => container.textContent ?? "",
    card: (id: string) => {
      const element = container.querySelector<HTMLElement>(`[data-platform="${id}"]`)
      if (element === null) throw new Error(`Missing platform card: ${id}`)
      return element
    },
    unmount() {
      dispose()
      container.remove()
    },
  }
}

function button(root: HTMLElement, name: string) {
  const found = [...root.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === name)
  if (found === undefined) throw new Error(`Missing button: ${name}`)
  return found
}

function type(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

beforeEach(() => {
  channels = []
  listError = undefined
  connects.length = 0
  disconnects.length = 0
  toggles.length = 0
  entitlement = account({ allowed: true, code: "granted" }, "pro")
})

afterEach(() => {
  document.body.replaceChildren()
})

describe.skipIf(isServer)("settings chat channels", () => {
  test("a Pro account gets the platform list and connecting sends only the entered credentials", async () => {
    const surface = await mount()
    expect(surface.text()).toContain("Slack")
    expect(surface.text()).toContain("Telegram")
    expect(surface.text()).toContain(en["settings.chatChannels.empty"])

    const telegram = surface.card("telegram")
    button(telegram, en["common.connect"]).click()
    await settle()

    const draft = telegram.querySelector<HTMLElement>(`[data-draft="telegram"]`)
    expect(draft).not.toBeNull()
    const inputs = [...draft!.querySelectorAll<HTMLInputElement>("input")]
    expect(inputs.map((input) => input.type)).toEqual(["password", "password"])
    type(inputs[0]!, "12345:bot-token")
    await settle()
    button(draft!, en["common.connect"]).click()
    await settle()

    expect(connects).toEqual([{ platform: "telegram", credentials: { botToken: "12345:bot-token" } }])
    const connected = surface.card("telegram")
    expect(connected.textContent).toContain(en["settings.chatChannels.connected"])
    expect(connected.textContent).toContain(TELEGRAM.webhookPath)
    // The value typed in is gone from the surface: the server returns which
    // fields are set, never the secret itself.
    expect(surface.text()).not.toContain("12345:bot-token")
    surface.unmount()
  })

  test("a missing required field is refused before the bridge is called", async () => {
    const surface = await mount()
    const slack = surface.card("slack")
    button(slack, en["common.connect"]).click()
    await settle()
    button(slack.querySelector<HTMLElement>('[data-draft="slack"]')!, en["common.connect"]).click()
    await settle()

    expect(connects).toEqual([])
    expect(surface.text()).toContain("Bot token")
    surface.unmount()
  })

  test("an explicit refusal offers an upgrade instead of the platform list", async () => {
    entitlement = account({ allowed: false, code: "not_entitled" }, "free")
    const surface = await mount()
    expect(surface.container.querySelector('[data-platform="slack"]')).toBeNull()
    expect(surface.text()).not.toContain(en["settings.chatChannels.empty"])
    // The refusal is explained rather than left as an empty list, and it names
    // the capability the server actually refused.
    expect(surface.text()).toContain("chat_channels")
    expect(surface.text().toLowerCase()).toContain("not included in your plan")
    surface.unmount()
  })

  test("an unanswered entitlement read is not a gate", async () => {
    entitlement = undefined
    const surface = await mount()
    expect(surface.text()).toContain("Slack")
    surface.unmount()
  })

  test("a connected channel can be disabled and disconnected", async () => {
    channels = [{ platform: "slack", enabled: true, configured: ["botToken"], messageCount: 3 }]
    const surface = await mount()
    const slack = surface.card("slack")
    expect(slack.textContent).toContain(en["settings.chatChannels.connected"])

    const toggle = slack.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(toggle).not.toBeNull()
    toggle!.click()
    await settle()
    expect(toggles).toEqual([["slack", false]])

    button(slack, en["common.disconnect"]).click()
    await settle()
    expect(disconnects).toEqual(["slack"])
    expect(surface.text()).toContain(en["settings.chatChannels.empty"])
    surface.unmount()
  })

  test("a Pro plan is not blocked when the control plane does not name the capability", async () => {
    // What a billing service built before this feature answers: the plan is pro
    // and the capability is simply absent from the response.
    entitlement = account(undefined, "pro")
    const surface = await mount()
    expect(surface.text()).toContain("Slack")
    expect(surface.text()).not.toContain("not included in your plan")
    surface.unmount()
  })

  test("a free plan is still gated when the capability is not named", async () => {
    entitlement = account(undefined, "free")
    const surface = await mount()
    expect(surface.container.querySelector('[data-platform="slack"]')).toBeNull()
    expect(surface.text().toLowerCase()).toContain("not included in your plan")
    surface.unmount()
  })

  test("the page uses the shared settings chrome, not a flush-left block", async () => {
    const surface = await mount()
    const header = surface.container.querySelector(".settings-v2-tab-header")
    const body = surface.container.querySelector(".settings-v2-tab-body")
    expect(header).not.toBeNull()
    expect(body).not.toBeNull()
    expect(header!.querySelector(".settings-v2-tab-title")?.textContent).toBe(en["settings.chatChannels.title"])
    // The padded body is what insets the content like every other settings page.
    expect(body!.querySelector('[data-platform="slack"]')).not.toBeNull()
    surface.unmount()
  })

  test("an out-of-date server says so instead of showing an opaque IPC error", async () => {
    listError = "Error invoking remote method 'chat-channels': Error: Unknown route."
    const surface = await mount()
    expect(surface.text()).toContain(en["settings.chatChannels.unsupported"])
    expect(surface.container.querySelector('[role="alert"]')).toBeNull()
    expect(surface.text()).not.toContain("Unknown route")
    surface.unmount()
  })
})
