// Configuration for the self-hosted `omnia-server` process.
//
// The file is the source of truth for a deployment: it names the org, where the
// data lives, and which address the console is served from. The server bearer is
// generated once by `init` and never printed by `start`.

import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

import type { NetworkMode } from "./types"

export const SERVER_CONFIG_VERSION = 1
export const DEFAULT_PORT = 8787

export interface ServerConfig {
  version: typeof SERVER_CONFIG_VERSION
  edition: "enterprise"
  orgName: string
  adminEmail: string
  host: string
  port: number
  publicUrl: string
  /** `lan` answers from the request host; `public` pins `publicUrl`. */
  networkMode: NetworkMode
  /** Source checkout the build farm packages clients from. */
  buildRoot?: string
  dataDir: string
  token: string
  uiDir?: string
  trustProxy: boolean
  devOrigins: string[]
  licenseFile?: string
  licensePublicKeyFile?: string
  createdAt: number
  updatedAt: number
}

export function defaultHome(): string {
  const configured = process.env.OMNIA_SERVER_HOME
  if (configured !== undefined && configured.trim().length > 0) return resolve(configured)
  return join(homedir(), ".omnia-server")
}

export function configPath(home = defaultHome()): string {
  return join(home, "config.json")
}

export function defaultPublicUrl(host: string, port: number): string {
  return `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${port}`
}

export function newToken(): string {
  return randomBytes(32).toString("hex")
}

export function readConfig(file = configPath()): ServerConfig {
  if (!existsSync(file)) throw new Error(`No server configuration at ${file}. Run \`omnia-server init\` first.`)
  if (lstatSync(file).isSymbolicLink()) throw new Error(`Refusing to read ${file} through a symlink.`)
  const mode = statSync(file).mode & 0o777
  if (mode & 0o077) throw new Error(`${file} is group/world readable (${mode.toString(8)}). Run: chmod 600 ${file}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    throw new Error(`${file} is not valid JSON.`)
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error(`${file} has an unexpected shape.`)
  const record = parsed as Record<string, unknown>
  if (record.version !== SERVER_CONFIG_VERSION) throw new Error(`${file} was written by a different omnia-server version.`)
  if (record.edition !== "enterprise") throw new Error(`${file} is not an enterprise configuration.`)
  if (typeof record.token !== "string" || record.token.length < 32) throw new Error(`${file} has no usable server token.`)
  if (record.networkMode !== undefined && record.networkMode !== "lan" && record.networkMode !== "public") {
    throw new Error(`${file} has an unknown networkMode.`)
  }
  // Deployments written before the LAN/public split were served from a public
  // URL, and keep behaving that way.
  return { ...(parsed as ServerConfig), networkMode: record.networkMode === "lan" ? "lan" : "public" }
}

export function writeConfig(config: ServerConfig, file = configPath()): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error(`Refusing to write ${file} through a symlink.`)
  const temporary = `${file}.${process.pid}.tmp`
  try {
    const handle = openSync(temporary, "wx", 0o600)
    try {
      writeFileSync(handle, JSON.stringify(config, null, 2))
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
    chmodSync(temporary, 0o600)
    renameSync(temporary, file)
    chmodSync(file, 0o600)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

export function makeConfig(input: {
  home?: string
  orgName: string
  adminEmail: string
  host?: string
  port?: number
  publicUrl?: string
  networkMode?: NetworkMode
  buildRoot?: string
  uiDir?: string
  trustProxy?: boolean
  devOrigins?: string[]
  licenseFile?: string
  licensePublicKeyFile?: string
  dataDir?: string
}): ServerConfig {
  const home = input.home ?? defaultHome()
  const at = Date.now()
  const host = input.host ?? "127.0.0.1"
  const port = input.port ?? DEFAULT_PORT
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("The port must be an integer between 1 and 65535.")
  return {
    version: SERVER_CONFIG_VERSION,
    edition: "enterprise",
    orgName: input.orgName,
    adminEmail: input.adminEmail,
    host,
    port,
    publicUrl: (input.publicUrl ?? defaultPublicUrl(host, port)).replace(/\/+$/, ""),
    networkMode: input.networkMode ?? "public",
    ...(input.buildRoot === undefined ? {} : { buildRoot: resolve(input.buildRoot) }),
    dataDir: resolve(input.dataDir ?? join(home, "data")),
    token: newToken(),
    ...(input.uiDir === undefined ? {} : { uiDir: resolve(input.uiDir) }),
    trustProxy: input.trustProxy ?? false,
    devOrigins: input.devOrigins ?? [],
    ...(input.licenseFile === undefined ? {} : { licenseFile: resolve(input.licenseFile) }),
    ...(input.licensePublicKeyFile === undefined ? {} : { licensePublicKeyFile: resolve(input.licensePublicKeyFile) }),
    createdAt: at,
    updatedAt: at,
  }
}

export function storePath(config: ServerConfig): string {
  return join(config.dataDir, "enterprise.json")
}

export function runtimePath(home = defaultHome()): string {
  return join(home, "runtime.json")
}

export function defaultUiDir(): string {
  const configured = process.env.OMNIA_ENTERPRISE_UI_DIR
  if (configured !== undefined && configured.trim().length > 0) return resolve(configured)
  // Source checkout: packages/omnia/src/enterprise -> packages/omnia-enterprise/dist
  const fromSource = resolve(import.meta.dir, "../../../omnia-enterprise/dist")
  if (existsSync(join(fromSource, "index.html"))) return fromSource
  // Packaged layout: the console sits next to the binary as enterprise-ui/.
  const besideBinary = join(dirname(process.execPath), "enterprise-ui")
  if (existsSync(join(besideBinary, "index.html"))) return besideBinary
  return fromSource
}

export function readLicensePublicKey(config: ServerConfig): string | undefined {
  const inline = process.env.OMNIA_ENTERPRISE_LICENSE_PUBLIC_KEY
  if (inline !== undefined && inline.trim().length > 0) return inline
  if (config.licensePublicKeyFile === undefined) return undefined
  return readFileSync(config.licensePublicKeyFile, "utf8")
}

export function readLicenseToken(config: ServerConfig): string | undefined {
  const inline = process.env.OMNIA_ENTERPRISE_LICENSE
  if (inline !== undefined && inline.trim().length > 0) return inline.trim()
  if (config.licenseFile === undefined) return undefined
  return readFileSync(config.licenseFile, "utf8").trim()
}
