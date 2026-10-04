import Store from "electron-store"
import electron from "electron"
import { rmSync } from "node:fs"
import { join } from "node:path"

import { SETTINGS_STORE } from "./store-keys"
import { deleteStoreFileIfEmpty } from "./store-cleanup"

const cache = new Map<string, Store>()

// We cannot instantiate the electron-store at module load time because
// module import hoisting causes this to run before app.setPath("userData", ...)
// in index.ts has executed, which would result in files being written to the default directory
// (e.g. bad: %APPDATA%\@opencode-ai\desktop\opencode.settings vs good: %APPDATA%\ai.opencode.desktop.dev\opencode.settings).
export function getStore(name = SETTINGS_STORE) {
  requireStoreName(name)
  const cached = cache.get(name)
  if (cached) return cached
  const next = new Store({
    name,
    cwd: electron.app.getPath("userData"),
    fileExtension: "",
    accessPropertiesByDotNotation: false,
  })
  cache.set(name, next)
  return next
}

export async function removeStoreFileIfEmpty(name: string) {
  requireStoreName(name)
  if (await deleteStoreFileIfEmpty(electron.app.getPath("userData"), name)) cache.delete(name)
}

export function removeStoreFile(name: string) {
  requireStoreName(name)
  rmSync(join(electron.app.getPath("userData"), name), { force: true })
  cache.delete(name)
}

// Store names reach the main process from the renderer (`store-get`,
// `store-set`, `store-delete`, `store-clear`) and conf resolves them against
// userData with `path.resolve`, so a name carrying path separators, `..`, or a
// NUL byte reads and writes files outside the app data directory. Plain file
// names (including ones with spaces) stay allowed.
function requireStoreName(name: string) {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new Error("Invalid store name")
  }
}
