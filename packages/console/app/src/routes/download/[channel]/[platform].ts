import type { APIEvent } from "@solidjs/start"
import type { DownloadPlatform } from "../types"

/**
 * Desktop artifacts are named by the packaging manifest:
 *   packages/desktop/electron-builder.config.ts -> artifactName:
 *   "omnia-desktop-${os}-${arch}.${ext}"
 * The console runs on Workers and cannot import that config (no filesystem), so
 * the same `${os}`/`${arch}`/`${ext}` tokens are spelled out here. electron-builder
 * uses amd64 for the deb and x86_64 for rpm/AppImage on linux, and arm64/x64 on
 * macOS and Windows. Getting this wrong 502s every download button, because the
 * updater manifest only carries assets that were actually published.
 */
const artifactNames: Record<string, string> = {
  "darwin-aarch64-dmg": "omnia-desktop-mac-arm64.dmg",
  "darwin-x64-dmg": "omnia-desktop-mac-x64.dmg",
  "windows-x64-nsis": "omnia-desktop-win-x64.exe",
  "linux-x64-deb": "omnia-desktop-linux-amd64.deb",
  "linux-x64-appimage": "omnia-desktop-linux-x86_64.AppImage",
  "linux-x64-rpm": "omnia-desktop-linux-x86_64.rpm",
} satisfies Record<DownloadPlatform, string>

export async function GET({ params: { platform, channel } }: APIEvent) {
  const artifactName = artifactNames[platform]
  if (!artifactName) return new Response(null, { status: 404 })
  const feed = channel === "stable" ? "latest" : "beta"

  const release = await fetch(`https://opencode.ai/update/api/${feed}/desktop/opencode`)
  if (!release.ok) return new Response(null, { status: release.status })
  const location = getAssetUrl(await release.json(), artifactName)
  // No asset means this build was never published for that platform; answering
  // 404 keeps the row honest instead of redirecting somewhere unusable.
  if (!location) return new Response(null, { status: 404 })
  return Response.redirect(location, 302)
}

function getAssetUrl(input: unknown, artifactName: string) {
  if (!isRecord(input) || !isRecord(input.metadata) || !isRecord(input.metadata.files)) return undefined
  const asset = input.metadata.files[artifactName]
  if (!isRecord(asset) || typeof asset.url !== "string") return undefined
  // The manifest entry must be the artifact we asked for: a manifest that
  // answers with something else is a packaging/manifest mismatch, not a link.
  let url: URL
  try {
    url = new URL(asset.url)
  } catch {
    return undefined
  }
  if (decodeURIComponent(url.pathname.split("/").pop() ?? "") !== artifactName) return undefined
  return asset.url
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}
