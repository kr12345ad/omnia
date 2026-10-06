import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

const flags = new Set(process.argv.slice(2))
const known = ["--dry-run", "--keep-oauth", "--yes"]
const unknown = [...flags].filter((flag) => !known.includes(flag))
if (unknown.length > 0) {
  console.error(`Unknown option${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`)
  console.error("Usage: bun ./scripts/purge-local-data.ts --yes [--dry-run] [--keep-oauth]")
  process.exit(1)
}

const dryRun = flags.has("--dry-run")
const keepOauth = flags.has("--keep-oauth")
const confirmed = flags.has("--yes")

// The desktop userData directories hold the auth session, remote key, pairing
// config and the legacy server.json.
const OMNIA_DIRS = ["io.omnia.desktop", "io.omnia.desktop.dev", "io.omnia.desktop.beta", "omnia"]

// Only an Omnia-owned directory may be deleted. `opencode` under XDG_STATE_HOME
// is CLI and service state that this script cannot restore, so it is no longer a
// purge target; remove it by hand if that is really what you want.
const targets = [...OMNIA_DIRS.map((name) => ["config", name] as const), ["data", "omnia"] as const]

if (!confirmed) {
  console.error("Refusing to delete local data without an explicit --yes.")
  console.error("Run a dry run first to see exactly what would be removed:")
  console.error("  bun ./scripts/purge-local-data.ts --yes --dry-run")
  process.exit(1)
}

const home = realOrSelf(homedir())
const roots = {
  config: existingRoot(process.env.XDG_CONFIG_HOME?.trim(), join(home, ".config"), "XDG_CONFIG_HOME"),
  data: existingRoot(process.env.XDG_DATA_HOME?.trim(), join(home, ".local", "share"), "XDG_DATA_HOME"),
}

const planned = targets.flatMap(([root, name]) => {
  const base = roots[root]
  if (base === undefined) return []
  const target = resolve(base, name)
  if (!isOmniaName(name)) throw new Error(`refusing to delete ${name}: not an Omnia directory`)
  if (!inside(target, home)) {
    throw new Error(
      `refusing to delete ${target}: ${root} home resolves outside ${home}. XDG_* must point inside the home directory.`,
    )
  }
  return [target]
})

for (const target of planned) remove(target)
console.log(dryRun ? "Dry run complete; nothing was removed." : "Local Omnia data removed.")

function realOrSelf(path: string) {
  try {
    return statSync(path).isDirectory() ? realpathSync(path) : path
  } catch {
    return path
  }
}

/**
 * XDG_CONFIG_HOME and friends are unvalidated environment input. A value of `/`
 * turns the targets into `/omnia`, so the root has to exist and be a directory
 * inside the home directory before anything is derived from it.
 */
function existingRoot(value: string | undefined, fallback: string, variable: string) {
  const base = resolve(value && value.length > 0 ? value : fallback)
  if (!inside(base, home)) {
    throw new Error(`refusing to use ${variable}=${base}: it resolves outside ${home}`)
  }
  if (!existsSync(base) || !statSync(base).isDirectory()) {
    console.warn(`skip   ${base} (${variable} is not an existing directory)`)
    return undefined
  }
  return base
}

function inside(target: string, parent: string) {
  if (target === parent) return false
  const rel = relative(parent, target)
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)
}

function isOmniaName(name: string) {
  return OMNIA_DIRS.includes(name) || name.startsWith("io.omnia.")
}

function remove(target: string): void {
  if (!existsSync(target)) {
    console.log(`skip   ${target} (not found)`)
    return
  }
  // Symlinks are resolved before deletion so a link inside the home directory
  // cannot redirect the recursive delete somewhere else entirely.
  const real = realpathSync(target)
  if (!inside(real, home) || !isOmniaName(real.split(sep).pop() ?? "")) {
    throw new Error(`refusing to delete ${real}: not an Omnia directory inside ${home}`)
  }
  const githubOAuthFile = join(real, "github-oauth.json")
  if (dryRun) {
    console.log(`remove ${real}`)
    if (keepOauth && existsSync(githubOAuthFile)) console.log(`keep   ${githubOAuthFile}`)
    return
  }
  const preserved = keepOauth ? read(githubOAuthFile) : undefined
  rmSync(real, { recursive: true, force: true })
  if (preserved !== undefined) {
    mkdirSync(dirname(githubOAuthFile), { recursive: true })
    writeFileSync(githubOAuthFile, preserved.data, { mode: preserved.mode })
    chmodSync(githubOAuthFile, preserved.mode)
    console.log(`keep   ${githubOAuthFile}`)
  }
  console.log(`remove ${real}`)
}

function read(file: string): { data: Buffer; mode: number } | undefined {
  if (!existsSync(file)) return undefined
  return { data: readFileSync(file), mode: statSync(file).mode & 0o777 }
}
