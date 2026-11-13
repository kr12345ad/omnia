import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

import { readEnterpriseProfileFile } from "./src/main/omnia/enterprise"
import { parseChannel } from "./electron.vite.config"

const execFileAsync = promisify(execFile)
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")

const metainfoFpm = (appId: string) =>
  `${path.join(packageDir, "resources", `${appId}.metainfo.xml`)}=/usr/share/metainfo/${appId}.metainfo.xml`

/**
 * Packaging must never guess an identity. An unset or unknown channel used to
 * fall back to dev, which produced `io.omnia.desktop.dev` "Omnia Dev" binaries
 * (CLI bundled, no publish repository) while the bundle was built for prod.
 */
function requireChannel() {
  const raw = process.env.OPENCODE_CHANNEL
  if (!raw?.trim()) {
    throw new Error("OPENCODE_CHANNEL is unset; packaging requires an explicit channel (dev, beta, prod or latest)")
  }
  const channel = parseChannel(raw)
  if (!channel) {
    throw new Error(`OPENCODE_CHANNEL '${raw}' is not a release channel (expected dev, beta, prod or latest)`)
  }
  return channel
}

const AZURE_SIGNING_VARS = [
  "AZURE_TRUSTED_SIGNING_ENDPOINT",
  "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
  "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE",
]

async function assertSigned(file: string) {
  // script/sign-windows.ps1 exits 0 without signing when the Azure credentials
  // are missing or it is not running in Actions, so the signature on disk is the
  // only evidence that anything was signed.
  const literal = file.replaceAll("'", "''")
  const { stdout } = await execFileAsync("pwsh", [
    "-NoLogo",
    "-NoProfile",
    "-Command",
    `(Get-AuthenticodeSignature -LiteralPath '${literal}').Status`,
  ])
  const status = stdout.trim()
  if (status !== "Valid") throw new Error(`${file} is not validly signed (Authenticode status: ${status || "unknown"})`)
}

async function signWindows(configuration: { path: string }) {
  // Returning success without signing handed unsigned installers to users, and
  // `verifyUpdateCodeSignature: false` taught the updater to accept them.
  if (process.env.OMNIA_SKIP_WINDOWS_SIGNING === "1") {
    console.warn(`skipping Windows signing for ${configuration.path} because OMNIA_SKIP_WINDOWS_SIGNING=1`)
    return
  }
  if (process.platform !== "win32") {
    throw new Error(
      `cannot code sign ${configuration.path} off Windows; run the Windows build on a Windows host or set OMNIA_SKIP_WINDOWS_SIGNING=1 for a deliberately unsigned build`,
    )
  }
  const missing = AZURE_SIGNING_VARS.filter((name) => !process.env[name])
  if (missing.length > 0) {
    throw new Error(`cannot code sign ${configuration.path}: missing ${missing.join(", ")}`)
  }
  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
  await assertSigned(configuration.path)
}

// The in-app updater rejects any installer whose signer is not this publisher.
// Nothing in the repository records the certificate subject CN, so release
// builds take it from the environment and otherwise let electron-builder
// derive it from the certificate it just signed with.
const windowsPublisherName = process.env.OMNIA_WINDOWS_PUBLISHER_NAME?.trim()

// Portable builds ship as a self-contained AppImage with no publish provider:
// nothing phones home and the in-app updater is compiled out.
const portable = process.env.OMNIA_NO_PUBLISH === "1"
// Unsigned CI builds still need a valid .app. Electron ships its binary signed,
// but renaming and modifying the bundle invalidates that signature, so macOS
// reports the app as damaged unless the whole bundle is re-signed ad-hoc.
const skipMacSigning = process.env.OMNIA_SKIP_MAC_SIGNING === "1"
// Lean by default: no model weights and only the CPU llama.cpp runtime. Set
// OMNIA_INCLUDE_MODELS=1 or OMNIA_INCLUDE_ALL_LLAMA=1 for a full bundle.
const includeModels = process.env.OMNIA_INCLUDE_MODELS === "1"
const includeAllLlama = process.env.OMNIA_INCLUDE_ALL_LLAMA === "1"
// Cross-builds must bundle the runtimes for the artifact, not for the host that
// happens to run electron-builder (electron.vite.config.ts honors the same
// overrides when it resolves the native packages for the bundle).
const targetPlatform = process.env.OMNIA_TARGET_PLATFORM ?? process.platform
const targetArch = process.env.OMNIA_TARGET_ARCH ?? process.arch
const platformKey = targetPlatform === "win32" ? "win" : targetPlatform === "darwin" ? "darwin" : "linux"
const archKey = targetArch === "arm64" ? "arm64" : "x64"

const channel = requireChannel()

// Tenant builds carry their own application identity. Without it they would
// install as the public Omnia app, reuse its userData (and its sign-in), and
// ignore the distribution's profile.
const tenantAppId = process.env.OMNIA_APP_ID?.trim()
const tenantProductName = process.env.OMNIA_PRODUCT_NAME?.trim()
const tenantPackageName = process.env.OMNIA_PACKAGE_NAME?.trim()
const artifactPrefix = process.env.OMNIA_ARTIFACT_PREFIX?.trim() || "omnia-desktop"
const enterpriseProfilePath = process.env.OMNIA_ENTERPRISE_PROFILE?.trim()
// The baked profile must follow the served manifest schema. A build that asks
// for a tenant profile but cannot read one is a public Omnia binary wearing a
// tenant's name, so packaging fails instead of silently omitting the resource.
const enterpriseProfile =
  enterpriseProfilePath === undefined || enterpriseProfilePath.length === 0
    ? undefined
    : readEnterpriseProfileFile(enterpriseProfilePath)

if (tenantAppId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(tenantAppId)) {
  throw new Error(`OMNIA_APP_ID '${tenantAppId}' is not a valid application id`)
}
if (tenantAppId !== undefined && !tenantProductName) {
  throw new Error("OMNIA_APP_ID requires OMNIA_PRODUCT_NAME so the tenant build is named")
}
if (enterpriseProfilePath !== undefined && enterpriseProfilePath.length > 0 && enterpriseProfile === undefined) {
  throw new Error(
    `OMNIA_ENTERPRISE_PROFILE '${enterpriseProfilePath}' is missing or does not match the enterprise profile schema (kind, schema 1, appId, server, org.name)`,
  )
}
if (enterpriseProfile !== undefined) {
  if (tenantAppId === undefined) {
    throw new Error("OMNIA_ENTERPRISE_PROFILE requires OMNIA_APP_ID so the client installs as its own application")
  }
  if (tenantAppId !== enterpriseProfile.appId) {
    throw new Error(`OMNIA_APP_ID '${tenantAppId}' does not match the profile appId '${enterpriseProfile.appId}'`)
  }
  const profileProductName = enterpriseProfile.branding.productName?.trim() || enterpriseProfile.name
  if (tenantProductName !== profileProductName) {
    throw new Error(
      `OMNIA_PRODUCT_NAME '${tenantProductName ?? ""}' does not match the profile product name '${profileProductName}'`,
    )
  }
}

function testUpdateFeed() {
  const value = process.env.OMNIA_UPDATE_URL?.trim()
  if (!value) throw new Error("OMNIA_UPDATE_URL is required for beta update builds")
  if (!URL.canParse(value)) throw new Error("OMNIA_UPDATE_URL must be an absolute HTTPS URL")
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error("OMNIA_UPDATE_URL must be an absolute HTTPS URL without credentials, query, or fragment")
  return { provider: "generic" as const, url: url.toString().replace(/\/$/, ""), channel: "latest" }
}

const APP_IDS = {
  dev: "io.omnia.desktop.dev",
  beta: "io.omnia.desktop.beta",
  prod: "io.omnia.desktop",
} as const

const getBase = (appId: string): Configuration => ({
  // `${os}` and `${arch}` are electron-builder macros, not JavaScript.
  artifactName: artifactPrefix + "-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  // Linux launchers are .desktop files, so this is the desktop file name,
  // not just the app id. For prod, app id "ai.opencode.desktop" becomes
  // "ai.opencode.desktop.desktop".
  // https://developer.gnome.org/documentation/guidelines/maintainer/integrating.html
  // https://www.electron.build/docs/linux/
  extraMetadata: {
    desktopName: `${appId}.desktop`,
  },
  files: ["out/**/*"],
  extraResources: [
    // The desktop app runs its server through the bundled Bun CLI, so every
    // channel must ship the matching binary outside app.asar.
    {
      from: "resources/",
      to: "",
      filter: ["opencode-cli*"],
    },
    // The packaged runtime reads these from process.resourcesPath, so they must
    // stay outside app.asar (binaries cannot be executed from an asar archive).
    ...(existsSync(path.join(packageDir, "resources/icons")) ? [{ from: "resources/icons", to: "icons" }] : []),
    // Prebuilt macOS accessibility helper so the installed app does not need
    // a Swift toolchain.
    ...(existsSync(path.join(packageDir, "resources/mac")) ? [{ from: "resources/mac", to: "mac" }] : []),
    ...(existsSync(path.join(packageDir, "resources/llama"))
      ? [
          {
            from: "resources/llama",
            to: "llama",
            filter: includeAllLlama
              ? ["**/*"]
              : [`${platformKey}-${archKey}-native/**`, `${platformKey}-${archKey}-vulkan/**`],
          },
        ]
      : []),
    ...(includeModels && existsSync(path.join(packageDir, "resources/models"))
      ? [{ from: "resources/models", to: "models" }]
      : []),
    ...(existsSync(path.join(packageDir, "native"))
      ? [
          {
            from: "native/",
            to: "native/",
            filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
          },
        ]
      : []),
    // The tenant profile the main process reads from process.resourcesPath.
    ...(enterpriseProfilePath !== undefined && enterpriseProfilePath.length > 0 && enterpriseProfile !== undefined
      ? [{ from: enterpriseProfilePath, to: "enterprise.json" }]
      : []),
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    ...(skipMacSigning
      ? { identity: "-", hardenedRuntime: false, notarize: false }
      : { hardenedRuntime: true, notarize: true }),
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    extendInfo: {
      NSAppleEventsUsageDescription:
        "Omnia uses Apple events to drive the accessibility fallbacks that control applications on your behalf.",
      NSDocumentsFolderUsageDescription: "Omnia may read and write documents when a task you ask for needs them.",
      NSDownloadsFolderUsageDescription: "Omnia may save files and images to your Downloads folder when you ask it to.",
      NSDesktopFolderUsageDescription:
        "Omnia may read and write files on your Desktop when a task you ask for needs them.",
      NSSystemAdministrationUsageDescription:
        "Omnia asks for administrator approval only when a task you requested requires elevated access.",
      NSMicrophoneUsageDescription:
        "Omnia uses the microphone only when you press the voice input button, so your words can be transcribed locally.",
    },
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: !skipMacSigning,
  },
  protocols: {
    name: "Omnia",
    schemes: ["omnia"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
      // electron-builder publishes this into app-update.yml, which is what the
      // updater verifies an installer against before replacing the app.
      ...(windowsPublisherName ? { publisherName: windowsPublisherName } : {}),
    },
    forceCodeSigning: process.env.OMNIA_SKIP_WINDOWS_SIGNING !== "1",
    target: ["nsis"],
    verifyUpdateCodeSignature: true,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    executableName: appId,
    desktop: {
      entry: {
        // Match the installed .desktop file and hicolor icon basename so
        // Linux shells can associate the running Electron window with its launcher.
        StartupWMClass: appId,
      },
    },
    target: portable ? ["AppImage"] : ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const appId = tenantAppId ?? APP_IDS[channel]
  const base = getBase(appId)

  if (tenantAppId !== undefined && tenantProductName !== undefined) {
    const packageName = tenantPackageName ? `omnia-${tenantPackageName}` : "omnia-enterprise"
    return {
      ...base,
      appId: tenantAppId,
      productName: tenantProductName,
      protocols: { name: tenantProductName, schemes: ["omnia"] },
      deb: { fpm: [metainfoFpm(tenantAppId)] },
      rpm: { packageName, fpm: [metainfoFpm(tenantAppId)] },
    } satisfies Configuration
  }

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId,
        productName: "Omnia Dev",
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "omnia-dev", fpm: [metainfoFpm(appId)] },
      }
    }
    case "beta": {
      return {
        ...base,
        appId,
        productName: "Omnia Beta",
        protocols: { name: "Omnia Beta", schemes: ["omnia"] },
        ...(portable
          ? {}
          : { publish: testUpdateFeed() }),
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "omnia-beta", fpm: [metainfoFpm(appId)] },
      }
    }
    case "prod": {
      return {
        ...base,
        appId,
        productName: "Omnia",
        protocols: { name: "Omnia", schemes: ["omnia"] },
        ...(portable
          ? {}
          : { publish: { provider: "github", owner: "anomalyco", repo: "opencode", channel: "latest" } }),
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "omnia", fpm: [metainfoFpm(appId)] },
      }
    }
  }
}

export default getConfig()
