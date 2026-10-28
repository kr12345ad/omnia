import { expect, test } from "bun:test"
import type { Configuration } from "electron-builder"
import { existsSync } from "node:fs"
import { join } from "node:path"

import { parseChannel } from "./electron.vite.config"

const channels = [
  { channel: "dev", appId: "io.omnia.desktop.dev" },
  { channel: "beta", appId: "io.omnia.desktop.beta" },
  { channel: "prod", appId: "io.omnia.desktop" },
] as const

// A beta artifact carries its own update feed, so the config refuses to build
// one without OMNIA_UPDATE_URL. Tests that read the beta config supply a
// throwaway feed instead of depending on an operator's environment.
function withUpdateFeed(): () => void {
  const previous = process.env.OMNIA_UPDATE_URL
  process.env.OMNIA_UPDATE_URL = "https://updates.example.test/omnia"
  return () => {
    if (previous === undefined) delete process.env.OMNIA_UPDATE_URL
    else process.env.OMNIA_UPDATE_URL = previous
  }
}

for (const channel of channels) {
  test(`uses one Linux desktop identity for ${channel.channel}`, async () => {
    const previous = process.env.OPENCODE_CHANNEL
    process.env.OPENCODE_CHANNEL = channel.channel
    const restoreFeed = withUpdateFeed()

    try {
      const module = await import(`./electron-builder.config.ts?channel=${channel.channel}`)
      const config = module.default as Configuration

      expect(config.appId).toBe(channel.appId)
      expect(config.extraMetadata?.desktopName).toBe(`${channel.appId}.desktop`)
      expect(config.linux?.executableName).toBe(channel.appId)
      expect(config.linux?.desktop?.entry?.StartupWMClass).toBe(channel.appId)
      expect(config.deb?.fpm).toContainEqual(expect.stringContaining(`/usr/share/metainfo/${channel.appId}.metainfo.xml`))
      expect(config.rpm?.fpm).toContainEqual(expect.stringContaining(`/usr/share/metainfo/${channel.appId}.metainfo.xml`))
    } finally {
      restoreFeed()
      if (previous === undefined) delete process.env.OPENCODE_CHANNEL
      else process.env.OPENCODE_CHANNEL = previous
    }
  })
}

for (const channel of ["dev", "beta", "prod"] as const) {
  test(`bundles the CLI outside the ${channel} app archive`, async () => {
    const previous = process.env.OPENCODE_CHANNEL
    process.env.OPENCODE_CHANNEL = channel
    const restoreFeed = withUpdateFeed()
    const module = await import(`./electron-builder.config.ts?cli-resource=${channel}`)
    const config = module.default as Configuration
    restoreFeed()
    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous

    expect(config.files).toEqual(["out/**/*"])
    expect(config.extraResources).toContainEqual({
      from: "resources/",
      to: "",
      filter: ["opencode-cli*"],
    })
  })
}

// One shared resolver: the vite configs and electron-builder must agree, or a
// release build is packaged as "Omnia Dev" (io.omnia.desktop.dev) under a prod
// artifact name.
test("the shared channel resolver maps dev, beta and prod", () => {
  expect(parseChannel("dev")).toBe("dev")
  expect(parseChannel("beta")).toBe("beta")
  expect(parseChannel("prod")).toBe("prod")
  expect(parseChannel("latest")).toBe("prod")
  expect(parseChannel("production")).toBe("prod")
  expect(parseChannel("PROD")).toBe("prod")
})

test("the shared channel resolver rejects unset, empty and unknown values", () => {
  expect(parseChannel(undefined)).toBeUndefined()
  expect(parseChannel("")).toBeUndefined()
  expect(parseChannel("   ")).toBeUndefined()
  expect(parseChannel("nightly")).toBeUndefined()
  expect(parseChannel("prod-dev")).toBeUndefined()
})

const packaging = async (raw: string | undefined, cacheKey: string) => {
  const previous = process.env.OPENCODE_CHANNEL
  if (raw === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = raw
  const restoreFeed = withUpdateFeed()
  try {
    const module = await import(`./electron-builder.config.ts?${cacheKey}`)
    return module.default as Configuration
  } finally {
    restoreFeed()
    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous
  }
}

test("packaging refuses to guess a channel", async () => {
  await expect(packaging(undefined, "channel-unset")).rejects.toThrow(/OPENCODE_CHANNEL is unset/)
  await expect(packaging("", "channel-empty")).rejects.toThrow(/OPENCODE_CHANNEL is unset/)
  await expect(packaging("   ", "channel-blank")).rejects.toThrow(/OPENCODE_CHANNEL is unset/)
  await expect(packaging("nightly", "channel-unknown")).rejects.toThrow(/is not a release channel/)
  await expect(packaging("production-typo", "channel-typo")).rejects.toThrow(/is not a release channel/)
})

for (const [raw, appId, productName] of [
  ["dev", "io.omnia.desktop.dev", "Omnia Dev"],
  ["beta", "io.omnia.desktop.beta", "Omnia Beta"],
  ["prod", "io.omnia.desktop", "Omnia"],
  ["latest", "io.omnia.desktop", "Omnia"],
  ["production", "io.omnia.desktop", "Omnia"],
] as const) {
  test(`OPENCODE_CHANNEL=${raw} packages as ${productName}`, async () => {
    const config = await packaging(raw, `channel-identity-${raw}`)
    expect(config.appId).toBe(appId)
    expect(config.productName).toBe(productName)
  })
}

// A cross-build must bundle the llama.cpp runtimes for the artifact, not for the
// host that happens to run electron-builder.
test("the llama filter follows OMNIA_TARGET_PLATFORM/ARCH", async () => {
  const previousPlatform = process.env.OMNIA_TARGET_PLATFORM
  const previousArch = process.env.OMNIA_TARGET_ARCH
  process.env.OPENCODE_CHANNEL = "prod"
  process.env.OMNIA_TARGET_PLATFORM = "darwin"
  process.env.OMNIA_TARGET_ARCH = "arm64"
  try {
    const module = await import("./electron-builder.config.ts?target=darwin-arm64")
    const config = module.default as Configuration
    const filter = config.extraResources?.find((entry) => entry.to === "llama")?.filter
    // Without the llama resources there is nothing to filter, and no entry to
    // name a runtime after.
    if (existsSync(join(import.meta.dir, "resources", "llama"))) {
      expect(filter).toEqual(["darwin-arm64-native/**", "darwin-arm64-vulkan/**"])
      expect(filter).not.toContain(`${process.platform}-${process.arch}-native/**`)
    } else expect(filter).toBeUndefined()
  } finally {
    if (previousPlatform === undefined) delete process.env.OMNIA_TARGET_PLATFORM
    else process.env.OMNIA_TARGET_PLATFORM = previousPlatform
    if (previousArch === undefined) delete process.env.OMNIA_TARGET_ARCH
    else process.env.OMNIA_TARGET_ARCH = previousArch
    delete process.env.OPENCODE_CHANNEL
  }
})
