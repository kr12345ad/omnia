#!/usr/bin/env bun
// `omnia-server` — the self-hosted enterprise control plane.
//
// One binary, one config file, one data directory. `init` creates the deployment
// and a one-time owner setup link; `start` runs the server and the admin console.
// The server token is never printed: it is written to a 0600 config file, and
// the console has its own login.

import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { networkInterfaces } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { createHash } from "node:crypto"
import { verifyLicense } from "../enterprise/license"
import { ClientReleaseFarm, artifactPath, releaseDir } from "../enterprise/releases"
import { EnterpriseStoreError, openEnterpriseStore, sanitizeEmail, type EnterpriseStore } from "../enterprise/store"
import {
  PLATFORMS,
  ROLES,
  isNetworkMode,
  isPermissionMode,
  isRole,
  type ClientDistribution,
  type ClientFeatures,
  type ClientPermissions,
  type EnterpriseGroup,
  type EnterpriseUser,
  type Policies,
  type Role,
  type UserStatus,
} from "../enterprise/types"
import { activeUsers, byDay, byModel, byTool, byUser, totals, usageInWindow } from "../enterprise/metrics"
import {
  DEFAULT_PORT,
  configPath,
  defaultHome,
  defaultUiDir,
  makeConfig,
  readConfig,
  readLicensePublicKey,
  readLicenseToken,
  runtimePath,
  storePath,
  writeConfig,
  type ServerConfig,
} from "../enterprise/config"
import { hostStatus } from "../enterprise/releases"
import { OMNIA_SERVER_VERSION, startOmniaServer } from "./server"
import type { ServerComputerDriver } from "./computers"
import { createHostDriver } from "../daemon/host-driver"
import { LinuxHostDriver } from "../daemon/linux"
import type { HostDriver } from "../daemon/host-driver"
import type { CommandRequest } from "../protocol"

const ENTERPRISE_VERSION = "1.0.3"
const STARTED_AT = Date.now()

const HELP = `omnia-server ${ENTERPRISE_VERSION} — self-hosted enterprise control plane

Usage:
  omnia-server init [options]            Create a deployment and a one-time setup link
  omnia-server start [options]           Run the server and the admin console
  omnia-server status                    Check the running server
  omnia-server stop                      Stop the server started by this user
  omnia-server doctor                    Check the deployment for common problems
  omnia-server config show               Show configuration with secrets redacted
  omnia-server config path               Print the configuration file path
  omnia-server config get <key>          Read one setting
  omnia-server config set <key> <value>  Change one setting (restart required)
  omnia-server token rotate              Replace the server bearer token
  omnia-server token fingerprint         Print a non-secret token fingerprint
  omnia-server users [list]              List people, with optional filters
  omnia-server users show <id|email>     Show one person and their capabilities
  omnia-server users add                Create a person (password optional)
  omnia-server users update <id|email>  Change a role, status, groups or profile
  omnia-server users invite <email>     Create a one-time invitation link
  omnia-server users reset <id|email>   Create a one-time password link
  omnia-server users delete <id|email>  Remove a person and their sessions
  omnia-server groups [list]            List groups and their limits
  omnia-server groups show <id|name>    Show one group and its members
  omnia-server groups add               Create a group
  omnia-server groups update <id|name>  Change a group
  omnia-server groups delete <id|name>  Remove a group
  omnia-server invites [list]           List pending invitations
  omnia-server invites revoke <id>      Revoke an invitation
  omnia-server builds [list]            List client builds (distributions)
  omnia-server builds show <id|slug>    Show one build as JSON
  omnia-server builds create            Create a build
  omnia-server builds update <id|slug>  Change features, permissions, limits
  omnia-server builds publish <id|slug> Publish a version
  omnia-server builds manifest <id|slug> Print the manifest clients receive
  omnia-server builds feed <id|slug>    Print the update feed clients can poll
  omnia-server builds releases <id|slug> List installer builds
  omnia-server builds build <id|slug>   Build installers for selected platforms
  omnia-server builds installer <id|slug> <platform>  Copy a built installer out
  omnia-server builds import <id|slug>  Register an installer built on another machine
  omnia-server builds delete <id|slug>  Delete a build (requires --force)
  omnia-server policy show              Show the organization policy
  omnia-server policy set               Change the organization policy
  omnia-server audit                    Show recent audit events
  omnia-server audit export             Export the full audit log (--format json|csv)
  omnia-server usage                    Show usage for a window (default 30 days)
  omnia-server license status            Show plan, trial and license state
  omnia-server license inspect <file>    Verify a license without installing it
  omnia-server license activate <file>   Install a signed license
  omnia-server ban --email <address> --reason <text>  Ban an account on every install
  omnia-server ban --fingerprint <id> --reason <text> Ban one installation
  omnia-server unban --email <address>   Lift an account ban (also --fingerprint)
  omnia-server bans                      List bans, including lifted ones
  omnia-server version                   Print the version

Options:
  --home <dir>              Deployment directory (default ~/.omnia-server)
  --config <file>           Configuration file (default <home>/config.json)
  --org <name>              Organization name (init)
  --admin <email>           Initial owner email (init)
  --host <host>             Bind address (default 127.0.0.1)
  --port <port>             Port (default ${DEFAULT_PORT})
  --public-url <url>        Console URL; required behind a proxy
  --mode <lan|public>       lan answers from the address each client reaches (default public)
  --build-root <dir>        Omnia checkout whose packages/desktop is packaged for clients
  --ui-dir <dir>            Built admin console directory
  --license-public-key <f>  Ed25519 public key file used to verify licenses
  --trust-proxy             Trust X-Forwarded-For/Proto from the reverse proxy
  --dev-origin <origin>     Additional console origin for local development
  --local-driver            Register this machine as a controllable computer
  --force                   Overwrite an existing config (init)
  --reset-setup             Issue a new one-time setup link (init, no owner yet)

People and groups:
  --email <email>           Person to add, invite, reset or show
  --name <name>             Display name (or a group name)
  --role <role>             ${ROLES.join(" | ")}
  --status <status>         invited | active | suspended
  --groups <a,b>            Group ids or names, comma separated (empty clears)
  --employee-id <id>        Stable directory identifier
  --title <text>            Job title
  --department <text>       Department
  --password <secret>       Set a password immediately instead of an invite link
  --mfa <on|off>            Require a second factor for this person
  --query <text>            Filter people by email, name, title or id

Builds:
  --slug <slug>             Download URL segment
  --description <text>      Shown in the client launcher
  --platforms <a,b>         ${PLATFORMS.join(" | ")}
  --platform <platform>     Build one platform (repeatable)
  --deployment <lan|public> Where the client is reachable
  --permission <tool=mode>  read|edit|bash|task|network|externalDirectory|skill|computer
  --feature <name=on|off>   Toggle a client capability (repeatable)
  --telemetry <on|off>      Require client telemetry
  --default-model <model>   Default model for this build
  --allow-model <model>     Model allowlist entry (repeatable)
  --block-model <model>     Model denylist entry (repeatable)
  --version <semver>        Version to publish
  --notes <text>            Release notes
  --notes-file <file>       Release notes from a file

Policy:
  --require-mfa <on|off>    Organization-wide MFA (--session-hours, --idle-timeout)
  --ip-allowlist <a,b>      Allowed client addresses
  --model-mode <mode>       allowlist | denylist (--models <a,b>)
  --approve-new-models <on|off>
  --require-approval <a,b>  Tools that always need approval
  --allow-shell <on|off>    Also --allow-file-write, --allow-network,
                            --allow-computer-use, --allow-browser, --allow-secrets
  --retention-days <n>      Data retention (--audit-retention-days <n>)
  --residency <region>      us | eu | apac | self-hosted
  --allow-training <on|off> Also --redact-secrets, --block-pii-export,
                            --encryption-at-rest, --byok
  --egress-allowlist <a,b>  Allowed egress hosts (--block-public-egress <on|off>)
  --siem-webhook <url>      Forward audit events to a SIEM
  --export-format <format>  Default audit export: json | csv

Audit and usage:
  --limit <n>               Events to show (default 100)
  --action <action>         Filter audit events by action
  --format <json|csv>       Audit export format
  --out <file>              Write an export to a file instead of stdout
  --days <n>                Usage window (default 30)
  --json                    Print machine-readable output
`

interface Parsed {
  command: string
  positional: string[]
  /** A repeated flag accumulates, so `--permission bash=deny --permission edit=ask` works. */
  flags: Map<string, string | boolean | string[]>
}

function parse(argv: string[]): Parsed {
  const positional: string[] = []
  const flags = new Map<string, string | boolean | string[]>()
  const record = (name: string, value: string | boolean) => {
    const previous = flags.get(name)
    if (previous === undefined) flags.set(name, value)
    else if (Array.isArray(previous)) previous.push(String(value))
    else flags.set(name, [String(previous), String(value)])
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === "-h" || arg === "--help") {
      record("help", true)
      continue
    }
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }
    const body = arg.slice(2)
    const equals = body.indexOf("=")
    if (equals > 0) {
      record(body.slice(0, equals), body.slice(equals + 1))
      continue
    }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith("-")) {
      record(body, next)
      index += 1
      continue
    }
    record(body, true)
  }
  const command = positional.shift() ?? "help"
  return { command, positional, flags }
}

function flag(parsed: Parsed, name: string): string | undefined {
  const value = parsed.flags.get(name)
  return typeof value === "string" ? value : undefined
}

function values(parsed: Parsed, name: string): string[] {
  const value = parsed.flags.get(name)
  if (value === undefined) return []
  return Array.isArray(value) ? value : typeof value === "string" ? [value] : []
}

function bool(parsed: Parsed, name: string): boolean {
  return parsed.flags.get(name) === true
}

function configFile(parsed: Parsed): string {
  return flag(parsed, "config") ?? configPath(flag(parsed, "home") ?? defaultHome())
}

function homeDir(parsed: Parsed): string {
  return flag(parsed, "home") ?? defaultHome()
}

function ok(message: string) {
  console.log(`  ok    ${message}`)
}

function warn(message: string) {
  console.log(`  warn  ${message}`)
}

function fail(message: string) {
  console.log(`  fail  ${message}`)
}

function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16)
}

function lanAddress(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address
    }
  }
  return undefined
}

/** The address an operator should open. LAN mode has no configured origin. */
function consoleUrl(config: ServerConfig): string {
  if (config.networkMode !== "lan") return config.publicUrl
  const host =
    config.host === "0.0.0.0" || config.host === "::"
      ? lanAddress() ?? "127.0.0.1"
      : config.host
  return `http://${host}:${config.port}`
}

function setupUrl(config: ServerConfig, token: string): string {
  return `${consoleUrl(config)}/admin/#/setup?token=${encodeURIComponent(token)}`
}

function writeSetupFile(config: ServerConfig, token: string, home: string): string {
  const file = join(home, "setup-token.txt")
  writeFileSync(file, `${setupUrl(config, token)}\n`, { mode: 0o600 })
  return file
}

export function initCommand(parsed: Parsed): number {
  const home = homeDir(parsed)
  const file = configFile(parsed)
  const orgName = flag(parsed, "org")?.trim() || "Acme"
  const adminEmail = sanitizeEmail(flag(parsed, "admin") ?? "admin@example.com")
  if (adminEmail === undefined) {
    console.error("--admin must be a valid email address.")
    return 1
  }
  const port = flag(parsed, "port") === undefined ? DEFAULT_PORT : Number(flag(parsed, "port"))
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("--port must be an integer between 1 and 65535.")
    return 1
  }
  if (existsSync(file) && !bool(parsed, "force") && !bool(parsed, "reset-setup")) {
    console.error(`A configuration already exists at ${file}. Use --force to replace it.`)
    return 1
  }
  const modeFlag = flag(parsed, "mode")
  if (modeFlag !== undefined && modeFlag !== "lan" && modeFlag !== "public") {
    console.error("--mode must be lan or public.")
    return 1
  }
  const networkMode = modeFlag === "lan" ? "lan" : "public"
  // A LAN deployment binds the network interface by default; otherwise the
  // console would be reachable only from the server's own machine.
  const host = flag(parsed, "host") ?? (networkMode === "lan" ? "0.0.0.0" : "127.0.0.1")

  mkdirSync(home, { recursive: true, mode: 0o700 })
  const config =
    existsSync(file) && bool(parsed, "reset-setup") && !bool(parsed, "force")
      ? readConfig(file)
      : makeConfig({
          home,
          orgName,
          adminEmail,
          host,
          port,
          networkMode,
          ...(flag(parsed, "public-url") === undefined
            ? {}
            : { publicUrl: flag(parsed, "public-url") }),
          ...(flag(parsed, "build-root") === undefined ? {} : { buildRoot: flag(parsed, "build-root") }),
          ...(flag(parsed, "ui-dir") === undefined ? {} : { uiDir: flag(parsed, "ui-dir") }),
          ...(bool(parsed, "trust-proxy") ? { trustProxy: true } : {}),
          ...(flag(parsed, "dev-origin") === undefined ? {} : { devOrigins: [flag(parsed, "dev-origin")!] }),
          ...(flag(parsed, "license-public-key") === undefined
            ? {}
            : { licensePublicKeyFile: flag(parsed, "license-public-key") }),
        })

  const store = openEnterpriseStore({
    file: storePath(config),
    orgName: config.orgName,
    adminEmail: config.adminEmail,
  })
  if (store.hasOwner()) {
    if (bool(parsed, "reset-setup")) {
      console.error("This deployment already has an owner. Use the console to reset passwords.")
      return 1
    }
    warn("This deployment already has an owner; no new setup link was created.")
    writeConfig(config, file)
    console.log(`\nConfig:  ${file}`)
    console.log(`Console: ${consoleUrl(config)}/admin`)
    return 0
  }

  writeConfig(config, file)
  const bootstrap = store.bootstrap(true)
  if (bootstrap === undefined) {
    console.error("Could not create a setup token.")
    return 1
  }
  const linkFile = writeSetupFile(config, bootstrap.token, home)

  console.log(`\nOmnia Enterprise ${ENTERPRISE_VERSION} is initialized.\n`)
  console.log(`  Organization  ${config.orgName}`)
  console.log(`  Owner email   ${config.adminEmail}`)
  console.log(`  Mode          ${config.networkMode}${config.networkMode === "lan" ? ` (${config.host}:${config.port})` : ""}`)
  console.log(`  Config        ${file} (0600)`)
  console.log(`  Data          ${config.dataDir}`)
  console.log(`  Console       ${consoleUrl(config)}/admin`)
  console.log(`  Version       ${ENTERPRISE_VERSION}`)
  console.log(`\n  One-time setup link (expires in 24 hours):`)
  console.log(`  ${setupUrl(config, bootstrap.token)}`)
  console.log(`\n  Also written to ${linkFile} (0600).`)
  console.log(`\nNext: omnia-server start${config.uiDir === undefined ? "" : ` --ui-dir ${config.uiDir}`}`)
  console.log(`      Build the console first: bun run --cwd packages/omnia-enterprise build\n`)
  return 0
}

function toServerDriver(driver: HostDriver): ServerComputerDriver {
  return {
    id: driver.id,
    backend: driver.backend,
    ...(driver.engine === undefined ? {} : { cua: driver.engine }),
    getInfo: () => driver.getInfo(),
    capabilities: () => driver.capabilities ?? [],
    observe: (request) => driver.observe(request),
    find: (request) => driver.find(request),
    execute: (action) => driver.execute(action),
    ...(driver.runCommand === undefined ? {} : { runCommand: (request: CommandRequest) => driver.runCommand!(request) }),
    ...(driver.readText === undefined
      ? {}
      : { readText: (input: Parameters<NonNullable<HostDriver["readText"]>>[0]) => driver.readText!(input) }),
    ...(driver.readClipboard === undefined ? {} : { readClipboard: () => driver.readClipboard!() }),
    ...(driver.writeClipboard === undefined ? {} : { writeClipboard: (text: string) => driver.writeClipboard!(text) }),
    ...(driver.writeClipboardImage === undefined
      ? {}
      : { writeClipboardImage: (path: string) => driver.writeClipboardImage!(path) }),
    ...(driver.pointerPosition === undefined ? {} : { pointerPosition: () => driver.pointerPosition!() }),
    ...(driver.hoverPointer === undefined
      ? {}
      : { hoverPointer: (x: number, y: number, holdMs?: number) => driver.hoverPointer!(x, y, holdMs) }),
    ...(driver.mouseDown === undefined ? {} : { mouseDown: (button?: number) => driver.mouseDown!(button) }),
    ...(driver.mouseUp === undefined ? {} : { mouseUp: (button?: number) => driver.mouseUp!(button) }),
    ...(driver.releaseStuckKeys === undefined ? {} : { releaseStuckKeys: () => driver.releaseStuckKeys!() }),
    ...(driver.grabInput === undefined ? {} : { grabInput: (reason?: string) => driver.grabInput!(reason) }),
    ...(driver.releaseInput === undefined ? {} : { releaseInput: () => driver.releaseInput!() }),
    ...(driver.inputGrabState === undefined ? {} : { inputGrabState: () => driver.inputGrabState!() }),
    ...(driver.subscribeInputGrab === undefined
      ? {}
      : {
          subscribeInputGrab: (listener: Parameters<NonNullable<HostDriver["subscribeInputGrab"]>>[0]) =>
            driver.subscribeInputGrab!(listener),
        }),
    revalidateTarget: (reference) => driver.revalidateTarget(reference),
  }
}

function localDriver(): HostDriver | undefined {
  if (process.platform !== "linux") return createHostDriver()
  const host = new LinuxHostDriver()
  if (!host.available) return undefined
  return createHostDriver(host)
}

export async function startCommand(parsed: Parsed): Promise<number> {
  const file = configFile(parsed)
  let config: ServerConfig
  try {
    config = readConfig(file)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
  if (flag(parsed, "port") !== undefined) config.port = Number(flag(parsed, "port"))
  if (flag(parsed, "host") !== undefined) config.host = flag(parsed, "host")!
  if (flag(parsed, "public-url") !== undefined) config.publicUrl = flag(parsed, "public-url")!.replace(/\/+$/, "")
  if (existsSync(runtimePath(homeDir(parsed)))) {
    const running = readRuntime(homeDir(parsed))
    if (running !== undefined && processAlive(running.pid)) {
      console.error(`omnia-server is already running (pid ${running.pid}) at ${running.url}.`)
      return 1
    }
  }

  const licensePublicKey = readLicensePublicKey(config)
  const store = openEnterpriseStore({
    file: storePath(config),
    orgName: config.orgName,
    adminEmail: config.adminEmail,
  })
  const bootstrap = store.bootstrap()
  if (bootstrap !== undefined) {
    const linkFile = writeSetupFile(config, bootstrap.token, homeDir(parsed))
    console.log(`\n  First run: open ${setupUrl(config, bootstrap.token)}`)
    console.log(`  The same link is in ${linkFile} (0600), valid for 24 hours.\n`)
  }

  const tokenFromEnv = process.env.OMNIA_SERVER_TOKEN
  const driver = bool(parsed, "local-driver") || process.env.OMNIA_LOCAL_DRIVER === "1" ? localDriver() : undefined
  if ((bool(parsed, "local-driver") || process.env.OMNIA_LOCAL_DRIVER === "1") && driver === undefined) {
    console.error("A local driver was requested, but this host has no available input backend.")
    return 1
  }

  const handle = await startOmniaServer({
    host: config.host,
    port: config.port,
    publicUrl: config.publicUrl,
    ...(tokenFromEnv === undefined ? { token: config.token } : { token: tokenFromEnv }),
    version: ENTERPRISE_VERSION,
    drivers: driver === undefined ? [] : [toServerDriver(driver)],
    corsOrigins: [config.publicUrl, ...config.devOrigins].filter((origin) => origin.length > 0),
    enterprise: {
      file: storePath(config),
      uiDir: config.uiDir ?? defaultUiDir(),
      publicUrl: config.publicUrl,
      mode: config.networkMode,
      ...(config.buildRoot === undefined ? {} : { buildRoot: config.buildRoot }),
      orgName: config.orgName,
      adminEmail: config.adminEmail,
      ...(licensePublicKey === undefined ? {} : { licensePublicKey }),
      trustProxy: config.trustProxy,
      devOrigins: config.devOrigins,
      allowRemote: true,
    },
  })

  const runtime = {
    pid: process.pid,
    url: handle.url,
    ...(handle.grpc === undefined ? {} : { grpcUrl: handle.grpc.url, grpcPort: handle.grpc.port }),
    publicUrl: config.publicUrl,
    consoleUrl: `${consoleUrl(config)}/admin`,
    startedAt: Date.now(),
    version: ENTERPRISE_VERSION,
    org: config.orgName,
  }
  const runtimeFile = runtimePath(homeDir(parsed))
  writeFileSync(runtimeFile, JSON.stringify(runtime, null, 2), { mode: 0o600 })

  const plan = handle.enterprise?.store.plan() ?? "unknown"
  const license = handle.enterprise?.store.organization().license
  console.log(`\nOmnia Enterprise ${ENTERPRISE_VERSION}`)
  console.log(`  Mode      ${config.networkMode}`)
  console.log(`  Console   ${consoleUrl(config)}/admin`)
  console.log(`  API       ${handle.url}/v1/enterprise`)
  console.log(`  Server    ${handle.serverId}`)
  console.log(`  Plan      ${plan}${license?.claims === undefined ? " (trial)" : ` · expires ${new Date(license.claims.expiresAt).toISOString().slice(0, 10)}`}`)
  if (handle.enterprise?.store.plan() === "trial") {
    const days = Math.max(0, Math.ceil((handle.enterprise.store.organization().trialEndsAt - Date.now()) / 86_400_000))
    console.log(`  Trial     ${days} day${days === 1 ? "" : "s"} remaining`)
  }
  console.log(`  State     ${storePath(config)}`)
  console.log(`\n  Press Ctrl+C to stop.\n`)

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received; stopping Omnia Enterprise...`)
    await handle.stop().catch(() => undefined)
    rmSync(runtimeFile, { force: true })
    process.exit(0)
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
  process.on("SIGINT", () => void shutdown("SIGINT"))

  await new Promise(() => {})
  return 0
}

interface RuntimeInfo {
  pid: number
  url: string
  publicUrl: string
  consoleUrl: string
  startedAt: number
  version: string
  org: string
}

function readRuntime(home: string): RuntimeInfo | undefined {
  const file = runtimePath(home)
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RuntimeInfo
  } catch {
    return undefined
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function doctorCommand(parsed: Parsed): Promise<number> {
  const file = configFile(parsed)
  let failures = 0
  const check = (condition: boolean, message: string) => {
    if (condition) ok(message)
    else {
      fail(message)
      failures += 1
    }
  }

  console.log(`\nomnia-server doctor\n`)
  check(typeof Bun !== "undefined", `Bun ${typeof Bun === "undefined" ? "not found" : Bun.version}`)
  let config: ServerConfig | undefined
  try {
    config = readConfig(file)
    ok(`Config ${file} is present and 0600`)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
    return 1
  }

  if (config.networkMode === "lan") {
    ok(`LAN mode: clients are answered from the address they reach (console ${consoleUrl(config)}/admin)`)
  } else {
    try {
      new URL(config.publicUrl)
      ok(`Public URL ${config.publicUrl}`)
    } catch {
      fail(`Public URL ${config.publicUrl} is not a valid URL`)
    }
  }

  const build = hostStatus(config.buildRoot)
  if (!build.host.ready) warn(build.host.reason ?? "Client builds are unavailable on this host")
  else {
    const ready = build.targets.filter((target) => target.supported).map((target) => target.platform)
    const blocked = build.targets.filter((target) => !target.supported)
    ok(`Client builds available for ${ready.length === 0 ? "no platform" : ready.join(", ")}`)
    for (const target of blocked) warn(`${target.platform}: ${target.reason}`)
  }

  try {
    accessSync(config.dataDir, constants.W_OK)
    ok(`Data directory ${config.dataDir} is writable`)
  } catch {
    fail(`Data directory ${config.dataDir} is not writable`)
  }

  try {
    const store = openEnterpriseStore({ file: storePath(config) })
    ok(`State ${storePath(config)} parses (${store.users().length} users, ${store.distributions().length} distributions)`)
    if (store.hasOwner()) ok("An owner account exists")
    else warn("No owner yet: run `omnia-server init --reset-setup` for a setup link")
    const plan = store.plan()
    if (plan === "expired") fail("The trial has ended and no license is installed")
    else if (plan === "trial") {
      const days = Math.max(0, Math.ceil((store.organization().trialEndsAt - Date.now()) / 86_400_000))
      warn(`Running on the trial plan (${days} days left)`)
    } else ok(`Licensed plan: ${plan}`)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }

  const publicKey = readLicensePublicKey(config)
  if (publicKey === undefined) warn("No license public key configured; licenses cannot be activated")
  else {
    const token = readLicenseToken(config)
    if (token === undefined) warn("No license installed")
    else {
      const result = verifyLicense(token, publicKey, Date.now())
      if (result.valid) ok(`License verifies (${result.claims?.plan}, ${result.claims?.seats} seats)`)
      else fail(`License does not verify: ${result.error}`)
    }
  }

  const uiDir = config.uiDir ?? defaultUiDir()
  check(existsSync(join(uiDir, "index.html")), `Admin console build at ${uiDir}`)

  const portFree = await isPortFree(config.host, config.port)
  if (portFree) ok(`Port ${config.port} is free`)
  else {
    const running = readRuntime(homeDir(parsed))
    if (running !== undefined && processAlive(running.pid)) ok(`Port ${config.port} is held by omnia-server (pid ${running.pid})`)
    else fail(`Port ${config.port} is already in use`)
  }

  console.log(`\n${failures === 0 ? "No blocking problems found." : `${failures} problem${failures === 1 ? "" : "s"} found.`}\n`)
  return failures === 0 ? 0 : 1
}

function isPortFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once("error", () => resolve(false))
    server.listen(port, host === "0.0.0.0" ? undefined : host, () => {
      server.close(() => resolve(true))
    })
  })
}

export function configCommand(parsed: Parsed): number {
  const file = configFile(parsed)
  let config: ServerConfig
  try {
    config = readConfig(file)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
  const action = parsed.positional[0] ?? "show"
  if (action === "show" || action === "path") {
    if (action === "path") {
      console.log(file)
      return 0
    }
    console.log(JSON.stringify({ ...config, token: `<redacted · ${fingerprint(config.token)}>` }, null, 2))
    return 0
  }
  if (action === "get") {
    const key = parsed.positional[1]
    if (key === undefined) {
      console.error("Usage: omnia-server config get <key>")
      return 1
    }
    if (key === "token") {
      console.error("The server token is not printable. Use `omnia-server token fingerprint`.")
      return 1
    }
    const value = (config as unknown as Record<string, unknown>)[key]
    if (value === undefined) {
      console.error(`Unknown setting: ${key}`)
      return 1
    }
    console.log(typeof value === "string" ? value : JSON.stringify(value))
    return 0
  }
  if (action === "set") {
    const key = parsed.positional[1]
    const value = parsed.positional[2]
    if (key === undefined || value === undefined) {
      console.error("Usage: omnia-server config set <key> <value>")
      return 1
    }
    const editable = new Set(["orgName", "adminEmail", "host", "port", "publicUrl", "networkMode", "buildRoot", "uiDir", "trustProxy"])
    if (!editable.has(key)) {
      console.error(`Setting ${key} is not editable here. Editable: ${[...editable].join(", ")}`)
      return 1
    }
    const next = config as unknown as Record<string, unknown>
    if (key === "port") {
      const port = Number(value)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        console.error("port must be an integer between 1 and 65535.")
        return 1
      }
      next.port = port
    } else if (key === "trustProxy") {
      next.trustProxy = value === "true" || value === "1"
    } else if (key === "networkMode") {
      if (value !== "lan" && value !== "public") {
        console.error("networkMode must be lan or public.")
        return 1
      }
      next.networkMode = value
    } else if (key === "buildRoot") {
      if (value.length === 0) delete next.buildRoot
      else next.buildRoot = value
    } else if (key === "adminEmail") {
      const email = sanitizeEmail(value)
      if (email === undefined) {
        console.error("adminEmail must be a valid email address.")
        return 1
      }
      next.adminEmail = email
    } else {
      next[key] = value
    }
    next.updatedAt = Date.now()
    writeConfig(config, file)
    console.log(`Updated ${key}. Restart the server for it to take effect.`)
    return 0
  }
  console.error(`Unknown config action: ${action}`)
  return 1
}

export function tokenCommand(parsed: Parsed): number {
  const file = configFile(parsed)
  let config: ServerConfig
  try {
    config = readConfig(file)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
  const action = parsed.positional[0] ?? "fingerprint"
  if (action === "fingerprint") {
    console.log(fingerprint(config.token))
    return 0
  }
  if (action === "rotate") {
    const previous = fingerprint(config.token)
    config.token = makeConfig({
      home: homeDir(parsed),
      orgName: config.orgName,
      adminEmail: config.adminEmail,
    }).token
    config.updatedAt = Date.now()
    writeConfig(config, file)
    console.log(`Rotated the server token (${previous} -> ${fingerprint(config.token)}).`)
    console.log("Restart the server. Existing computer-control clients must be given the new token.")
    return 0
  }
  console.error(`Unknown token action: ${action}`)
  return 1
}

export function licenseCommand(parsed: Parsed): number {
  const file = configFile(parsed)
  let config: ServerConfig
  try {
    config = readConfig(file)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
  const action = parsed.positional[0] ?? "status"
  const publicKey = readLicensePublicKey(config)
  if (action === "status") {
    const store = openEnterpriseStore({ file: storePath(config) })
    const org = store.organization()
    const plan = store.plan()
    console.log(`Plan        ${plan}`)
    console.log(`Seats       ${JSON.stringify(store.seatUsage())}`)
    console.log(`Trial ends  ${new Date(org.trialEndsAt).toISOString()}`)
    if (org.license.claims === undefined) console.log(`License     none${org.license.error === undefined ? "" : ` (${org.license.error})`}`)
    else {
      console.log(`License     ${org.license.claims.id} · ${org.license.claims.plan}`)
      console.log(`Expires     ${new Date(org.license.claims.expiresAt).toISOString()}`)
    }
    return 0
  }
  if (action === "inspect" || action === "activate") {
    const path = parsed.positional[1]
    if (path === undefined) {
      console.error(`Usage: omnia-server license ${action} <file>`)
      return 1
    }
    let token: string
    try {
      token = readFileSync(path, "utf8").trim()
    } catch {
      console.error(`Could not read ${path}.`)
      return 1
    }
    if (publicKey === undefined) {
      console.error("No license public key configured. Use --license-public-key during init or set OMNIA_ENTERPRISE_LICENSE_PUBLIC_KEY.")
      return 1
    }
    const result = verifyLicense(token, publicKey, Date.now())
    if (!result.valid) {
      console.error(`License does not verify: ${result.error}`)
      return 1
    }
    console.log(`License     ${result.claims!.id}`)
    console.log(`Org         ${result.claims!.org}`)
    console.log(`Plan        ${result.claims!.plan}`)
    console.log(`Seats       ${result.claims!.seats}`)
    console.log(`Expires     ${new Date(result.claims!.expiresAt).toISOString()}`)
    if (action === "activate") {
      const store = openEnterpriseStore({ file: storePath(config) })
      store.setLicense(token, result.claims, undefined)
      config.licenseFile = path
      config.updatedAt = Date.now()
      writeConfig(config, file)
      console.log("\nLicense activated. Restart the server.")
    }
    return 0
  }
  console.error(`Unknown license action: ${action}`)
  return 1
}

// ── Admin commands ──────────────────────────────────────────────────────────
//
// These are the same operations the console performs, for operators who script
// a deployment instead of clicking through it. Each reads and writes the same
// store, so the audit trail records CLI changes like console changes.

const CLI_ACTOR = "cli"

function openCliStore(parsed: Parsed): { config: ServerConfig; store: EnterpriseStore } {
  const config = readConfig(configFile(parsed))
  const store = openEnterpriseStore({ file: storePath(config) })
  return { config, store }
}

function report(error: unknown): number {
  console.error(error instanceof Error ? error.message : String(error))
  return 1
}

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2))
}

function table(headers: string[], rows: string[][]) {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)))
  const line = (cells: string[]) =>
    cells
      .map((cell, index) => cell.padEnd(widths[index]!))
      .join("  ")
      .trimEnd()
  console.log(line(headers))
  console.log(widths.map((width) => "-".repeat(width)).join("  "))
  for (const row of rows) console.log(line(row))
}

/** `--flag a,b` as a trimmed list. Distinguishes absent from empty. */
function csv(parsed: Parsed, name: string): string[] | undefined {
  const value = flag(parsed, name)
  if (value === undefined) return undefined
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

function toggle(parsed: Parsed, name: string): boolean | undefined {
  const value = flag(parsed, name)
  if (value === undefined) return undefined
  if (value === "on" || value === "true" || value === "yes" || value === "1") return true
  if (value === "off" || value === "false" || value === "no" || value === "0") return false
  throw new EnterpriseStoreError(`--${name} must be on or off.`)
}

function numberValue(parsed: Parsed, name: string): number | undefined {
  const value = flag(parsed, name)
  if (value === undefined) return undefined
  const parsedValue = Number(value)
  if (!Number.isFinite(parsedValue) || parsedValue < 0) throw new EnterpriseStoreError(`--${name} must be a positive number.`)
  return parsedValue
}

function roleValue(parsed: Parsed): Role | undefined {
  const value = flag(parsed, "role")
  if (value === undefined) return undefined
  if (!isRole(value)) throw new EnterpriseStoreError(`--role must be one of ${ROLES.join(", ")}.`)
  return value
}

function groupRoleValue(parsed: Parsed): Exclude<Role, "owner"> | undefined {
  const role = roleValue(parsed)
  if (role === undefined) return undefined
  if (role === "owner") throw new EnterpriseStoreError("A group cannot grant ownership; assign an owner directly.")
  return role
}

function statusValue(parsed: Parsed): UserStatus | undefined {
  const value = flag(parsed, "status")
  if (value === undefined) return undefined
  if (value !== "invited" && value !== "active" && value !== "suspended") {
    throw new EnterpriseStoreError("--status must be invited, active or suspended.")
  }
  return value
}

function requireUser(store: EnterpriseStore, key: string | undefined): EnterpriseUser {
  if (key === undefined) throw new EnterpriseStoreError("An email, employee id or user id is required.")
  const user = store.findByIdentifier(key) ?? store.users().find((entry) => entry.id === key)
  if (user === undefined) throw new EnterpriseStoreError(`No person matches ${key}.`)
  return user
}

function requireGroup(store: EnterpriseStore, key: string | undefined): EnterpriseGroup {
  if (key === undefined) throw new EnterpriseStoreError("A group id or name is required.")
  const group = store.groups().find((entry) => entry.id === key || entry.name.toLowerCase() === key.toLowerCase())
  if (group === undefined) throw new EnterpriseStoreError(`No group matches ${key}.`)
  return group
}

function requireDistribution(store: EnterpriseStore, key: string | undefined): ClientDistribution {
  if (key === undefined) throw new EnterpriseStoreError("A build id or slug is required.")
  const distribution = store.distributions().find((entry) => entry.id === key || entry.slug === key)
  if (distribution === undefined) throw new EnterpriseStoreError(`No build matches ${key}.`)
  return distribution
}

function requirePlatform(value: string) {
  const platform = PLATFORMS.find((entry) => entry === value)
  if (platform === undefined) throw new EnterpriseStoreError(`Unknown platform ${value}. Known: ${PLATFORMS.join(", ")}.`)
  return platform
}

function groupIdsValue(store: EnterpriseStore, parsed: Parsed): string[] | undefined {
  const keys = csv(parsed, "groups")
  if (keys === undefined) return undefined
  return keys.map((key) => requireGroup(store, key).id)
}

const PERMISSION_TOOLS = ["read", "edit", "bash", "task", "network", "externalDirectory", "skill", "computer"] as const

/** `--permission bash=deny --permission edit=ask` over the current rules. */
function permissionsValue(parsed: Parsed): Partial<ClientPermissions> | undefined {
  const rules = values(parsed, "permission")
  if (rules.length === 0) return undefined
  const patch: Partial<ClientPermissions> = {}
  for (const rule of rules) {
    const [tool, mode, extra] = rule.split("=")
    if (tool === undefined || mode === undefined || extra !== undefined) {
      throw new EnterpriseStoreError(`--permission expects tool=allow|ask|deny, got ${rule}.`)
    }
    if (!(PERMISSION_TOOLS as readonly string[]).includes(tool)) {
      throw new EnterpriseStoreError(`Unknown tool ${tool}. Known: ${PERMISSION_TOOLS.join(", ")}.`)
    }
    if (!isPermissionMode(mode)) throw new EnterpriseStoreError(`Permission for ${tool} must be allow, ask or deny.`)
    patch[tool as keyof ClientPermissions] = mode
  }
  return patch
}

const FEATURE_NAMES = [
  "computerUse",
  "browserAutomation",
  "cloudVision",
  "liveView",
  "scheduledRuns",
  "chatChannels",
  "memory",
  "superskills",
  "subagents",
  "mcpMarketplace",
  "fileAttachments",
  "shellTool",
  "networkAccess",
  "credentialVault",
  "telemetry",
] as const

function featuresValue(parsed: Parsed): Partial<ClientFeatures> | undefined {
  const rules = values(parsed, "feature")
  if (rules.length === 0) return undefined
  const patch: Partial<ClientFeatures> = {}
  for (const rule of rules) {
    const [name, state, extra] = rule.split("=")
    if (name === undefined || state === undefined || extra !== undefined) {
      throw new EnterpriseStoreError(`--feature expects name=on|off, got ${rule}.`)
    }
    if (!(FEATURE_NAMES as readonly string[]).includes(name)) {
      throw new EnterpriseStoreError(`Unknown feature ${name}. Known: ${FEATURE_NAMES.join(", ")}.`)
    }
    if (state !== "on" && state !== "off") throw new EnterpriseStoreError(`Feature ${name} must be on or off, got ${state}.`)
    patch[name as keyof ClientFeatures] = state === "on"
  }
  return patch
}

function iso(at: number | undefined): string {
  return at === undefined ? "-" : new Date(at).toISOString().slice(0, 16).replace("T", " ")
}

function bytes(value: number | undefined): string {
  if (value === undefined) return "-"
  const units = ["B", "KB", "MB", "GB"]
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

function inviteUrl(config: ServerConfig, token: string): string {
  return `${consoleUrl(config)}/admin/#/invite?token=${encodeURIComponent(token)}`
}

/** Credentials never leave the machine in CLI output. */
function publicUser(user: EnterpriseUser) {
  const copy = { ...user }
  delete copy.passwordHash
  return copy
}

function permissionSummary(permissions: ClientPermissions): string {
  const tuned = Object.entries(permissions)
    .filter(([, mode]) => mode !== "allow")
    .map(([tool, mode]) => `${tool}:${mode}`)
  return tuned.length === 0 ? "all allow" : tuned.join(" ")
}

export async function usersCommand(parsed: Parsed): Promise<number> {
  try {
    const { config, store } = openCliStore(parsed)
    const action = parsed.positional[0] ?? "list"
    if (action === "list") {
      const role = roleValue(parsed)
      const status = statusValue(parsed)
      const query = flag(parsed, "query")?.trim().toLowerCase()
      const users = store.users().filter((user) => {
        if (role !== undefined && user.role !== role) return false
        if (status !== undefined && user.status !== status) return false
        if (query !== undefined && query.length > 0) {
          const haystack = [user.email, user.name, user.employeeId ?? "", user.title ?? "", user.department ?? ""]
            .join(" ")
            .toLowerCase()
          if (!haystack.includes(query)) return false
        }
        return true
      })
      if (bool(parsed, "json")) {
        printJson(users.map((user) => ({ ...publicUser(user), capabilities: store.capabilities(user) })))
        return 0
      }
      if (users.length === 0) {
        console.log("No people match.")
        return 0
      }
      const names = new Map(store.groups().map((group) => [group.id, group.name]))
      table(
        ["EMAIL", "NAME", "ROLE", "STATUS", "GROUPS", "LAST ACTIVE"],
        users.map((user) => [
          user.email,
          user.name,
          user.role,
          user.status,
          user.groupIds.map((id) => names.get(id) ?? id).join(", ") || "-",
          iso(user.lastActiveAt),
        ]),
      )
      const seats = store.seatUsage()
      console.log(
        `\n${users.length} of ${store.users().length} people · ${seats.used}/${seats.licensed} seats used` +
          (seats.available === null ? " (overage allowed)" : ` · ${seats.available} available`),
      )
      return 0
    }
    if (action === "show") {
      const user = requireUser(store, parsed.positional[1] ?? flag(parsed, "email"))
      printJson({
        ...publicUser(user),
        groups: store.groups().filter((group) => user.groupIds.includes(group.id)),
        capabilities: store.capabilities(user),
      })
      return 0
    }
    if (action === "add") {
      const email = flag(parsed, "email") ?? parsed.positional[1]
      if (email === undefined) {
        throw new EnterpriseStoreError("Usage: omnia-server users add --email <email> [--name <name>] [--role <role>]")
      }
      const password = flag(parsed, "password")
      const employeeId = flag(parsed, "employee-id")
      const title = flag(parsed, "title")
      const department = flag(parsed, "department")
      const groupIds = groupIdsValue(store, parsed)
      const user = await store.createUser({
        email,
        name: flag(parsed, "name") ?? "",
        role: roleValue(parsed) ?? "member",
        ...(employeeId === undefined ? {} : { employeeId }),
        ...(title === undefined ? {} : { title }),
        ...(department === undefined ? {} : { department }),
        ...(groupIds === undefined ? {} : { groupIds }),
        ...(password === undefined ? {} : { password }),
        createdBy: CLI_ACTOR,
      })
      if (password !== undefined) {
        console.log(`Created ${user.email} as ${user.role} (active).`)
        return 0
      }
      const reset = store.createResetToken(user.id, CLI_ACTOR)
      console.log(`Created ${user.email} as ${user.role} (invited).`)
      console.log(`One-time password link (expires ${iso(reset.invite.expiresAt)}):`)
      console.log(inviteUrl(config, reset.token))
      return 0
    }
    if (action === "invite") {
      const email = flag(parsed, "email") ?? parsed.positional[1]
      if (email === undefined) {
        throw new EnterpriseStoreError("Usage: omnia-server users invite <email> [--name <name>] [--role <role>]")
      }
      const name = flag(parsed, "name")
      const groupIds = groupIdsValue(store, parsed)
      const result = store.invite({
        email,
        ...(name === undefined ? {} : { name }),
        role: roleValue(parsed) ?? "member",
        ...(groupIds === undefined ? {} : { groupIds }),
        createdBy: CLI_ACTOR,
      })
      console.log(`Invited ${result.invite.email} as ${result.invite.role}.`)
      console.log(`One-time invitation link (expires ${iso(result.invite.expiresAt)}):`)
      console.log(inviteUrl(config, result.token))
      return 0
    }
    if (action === "reset") {
      const user = requireUser(store, parsed.positional[1] ?? flag(parsed, "email"))
      const reset = store.createResetToken(user.id, CLI_ACTOR)
      console.log(`Password reset link for ${user.email} (expires ${iso(reset.invite.expiresAt)}):`)
      console.log(inviteUrl(config, reset.token))
      return 0
    }
    if (action === "update") {
      const user = requireUser(store, parsed.positional[1] ?? flag(parsed, "email"))
      const patch: Parameters<EnterpriseStore["updateUser"]>[1] = {}
      const name = flag(parsed, "name")
      if (name !== undefined) patch.name = name
      const role = roleValue(parsed)
      if (role !== undefined) patch.role = role
      const status = statusValue(parsed)
      if (status !== undefined) patch.status = status
      const groupIds = groupIdsValue(store, parsed)
      if (groupIds !== undefined) patch.groupIds = groupIds
      const employeeId = flag(parsed, "employee-id")
      if (employeeId !== undefined) patch.employeeId = employeeId
      const title = flag(parsed, "title")
      if (title !== undefined) patch.title = title
      const department = flag(parsed, "department")
      if (department !== undefined) patch.department = department
      const mfa = toggle(parsed, "mfa")
      if (mfa !== undefined) patch.mfaEnabled = mfa
      if (Object.keys(patch).length === 0) {
        throw new EnterpriseStoreError(
          "No changes given. Pass --name, --role, --status, --groups, --title, --department, --employee-id or --mfa.",
        )
      }
      const updated = store.updateUser(user.id, patch, CLI_ACTOR)
      if (bool(parsed, "json")) printJson(publicUser(updated))
      else console.log(`Updated ${updated.email} (${updated.role}, ${updated.status}).`)
      return 0
    }
    if (action === "delete") {
      const user = requireUser(store, parsed.positional[1] ?? flag(parsed, "email"))
      store.deleteUser(user.id, CLI_ACTOR)
      console.log(`Deleted ${user.email} and revoked their sessions.`)
      return 0
    }
    throw new EnterpriseStoreError(`Unknown users action: ${action}`)
  } catch (error) {
    return report(error)
  }
}

export async function groupsCommand(parsed: Parsed): Promise<number> {
  try {
    const { store } = openCliStore(parsed)
    const action = parsed.positional[0] ?? "list"
    if (action === "list") {
      const groups = store.groups()
      if (bool(parsed, "json")) {
        printJson(groups)
        return 0
      }
      if (groups.length === 0) {
        console.log("No groups yet.")
        return 0
      }
      const counts = new Map<string, number>()
      for (const user of store.users()) {
        for (const id of user.groupIds) counts.set(id, (counts.get(id) ?? 0) + 1)
      }
      table(
        ["ID", "NAME", "ROLE", "MEMBERS", "MODELS", "TOKENS/MO", "SPEND/MO", "COMPUTERS"],
        groups.map((group) => [
          group.id,
          group.name,
          group.role,
          String(counts.get(group.id) ?? 0),
          group.modelAllowlist.length === 0 ? "org default" : group.modelAllowlist.join(", "),
          group.monthlyTokenLimit === undefined ? "-" : String(group.monthlyTokenLimit),
          group.monthlySpendLimitUsd === undefined ? "-" : `$${group.monthlySpendLimitUsd.toFixed(2)}`,
          group.maxComputers === undefined ? "-" : String(group.maxComputers),
        ]),
      )
      return 0
    }
    if (action === "show") {
      const group = requireGroup(store, parsed.positional[1] ?? flag(parsed, "name"))
      printJson({
        ...group,
        members: store
          .users()
          .filter((user) => user.groupIds.includes(group.id))
          .map((user) => ({ id: user.id, email: user.email, name: user.name, role: user.role, status: user.status })),
      })
      return 0
    }
    if (action === "add") {
      const name = flag(parsed, "name") ?? parsed.positional[1]
      if (name === undefined) {
        throw new EnterpriseStoreError("Usage: omnia-server groups add <name> [--role <role>] [--models <a,b>]")
      }
      const description = flag(parsed, "description")
      const models = csv(parsed, "models")
      const tokens = numberValue(parsed, "monthly-tokens")
      const spend = numberValue(parsed, "monthly-spend")
      const computers = numberValue(parsed, "max-computers")
      const role = groupRoleValue(parsed)
      const group = store.createGroup({
        name,
        ...(description === undefined ? {} : { description }),
        ...(role === undefined ? {} : { role }),
        ...(models === undefined ? {} : { modelAllowlist: models }),
        ...(tokens === undefined ? {} : { monthlyTokenLimit: tokens }),
        ...(spend === undefined ? {} : { monthlySpendLimitUsd: spend }),
        ...(computers === undefined ? {} : { maxComputers: computers }),
        actorId: CLI_ACTOR,
      })
      printJson(group)
      return 0
    }
    if (action === "update") {
      const group = requireGroup(store, parsed.positional[1] ?? flag(parsed, "name"))
      const patch: Partial<Omit<EnterpriseGroup, "id" | "createdAt">> = {}
      const name = flag(parsed, "name")
      if (name !== undefined) patch.name = name
      const description = flag(parsed, "description")
      if (description !== undefined) patch.description = description
      const role = groupRoleValue(parsed)
      if (role !== undefined) patch.role = role
      const models = csv(parsed, "models")
      if (models !== undefined) patch.modelAllowlist = models
      const tokens = numberValue(parsed, "monthly-tokens")
      if (tokens !== undefined) patch.monthlyTokenLimit = tokens
      const spend = numberValue(parsed, "monthly-spend")
      if (spend !== undefined) patch.monthlySpendLimitUsd = spend
      const computers = numberValue(parsed, "max-computers")
      if (computers !== undefined) patch.maxComputers = computers
      if (Object.keys(patch).length === 0) {
        throw new EnterpriseStoreError(
          "No changes given. Pass --name, --description, --role, --models, --monthly-tokens, --monthly-spend or --max-computers.",
        )
      }
      printJson(store.updateGroup(group.id, patch, CLI_ACTOR))
      return 0
    }
    if (action === "delete") {
      const group = requireGroup(store, parsed.positional[1] ?? flag(parsed, "name"))
      store.deleteGroup(group.id, CLI_ACTOR)
      console.log(`Deleted ${group.name}; its members keep their accounts.`)
      return 0
    }
    throw new EnterpriseStoreError(`Unknown groups action: ${action}`)
  } catch (error) {
    return report(error)
  }
}

function invitesCommand(parsed: Parsed): number {
  try {
    const { store } = openCliStore(parsed)
    const action = parsed.positional[0] ?? "list"
    if (action === "list") {
      const invites = store.invites()
      if (bool(parsed, "json")) {
        printJson(invites.map(({ tokenHash: _tokenHash, ...invite }) => invite))
        return 0
      }
      const pending = invites.filter((invite) => invite.acceptedAt === undefined && invite.revokedAt === undefined)
      if (invites.length === 0) {
        console.log("No invitations.")
        return 0
      }
      table(
        ["ID", "EMAIL", "ROLE", "PURPOSE", "STATUS", "CREATED", "EXPIRES"],
        invites.map((invite) => [
          invite.id,
          invite.email,
          invite.role,
          invite.purpose ?? "invite",
          invite.revokedAt !== undefined
            ? "revoked"
            : invite.acceptedAt !== undefined
              ? "accepted"
              : invite.expiresAt <= Date.now()
                ? "expired"
                : "pending",
          iso(invite.createdAt),
          iso(invite.expiresAt),
        ]),
      )
      console.log(`\n${pending.length} pending of ${invites.length} total.`)
      return 0
    }
    if (action === "revoke") {
      const id = parsed.positional[1]
      if (id === undefined) throw new EnterpriseStoreError("Usage: omnia-server invites revoke <id>")
      store.revokeInvite(id, CLI_ACTOR)
      console.log(`Revoked ${id}.`)
      return 0
    }
    throw new EnterpriseStoreError(`Unknown invites action: ${action}`)
  } catch (error) {
    return report(error)
  }
}

export async function buildsCommand(parsed: Parsed): Promise<number> {
  try {
    const { config, store } = openCliStore(parsed)
    const action = parsed.positional[0] ?? "list"
    if (action === "list") {
      const distributions = store.distributions()
      if (bool(parsed, "json")) {
        printJson(distributions)
        return 0
      }
      if (distributions.length === 0) {
        console.log("No builds yet. Create one with `omnia-server builds create <name>`.")
        return 0
      }
      table(
        ["SLUG", "NAME", "STATUS", "VERSION", "PLATFORMS", "PERMISSIONS"],
        distributions.map((distribution) => [
          distribution.slug,
          distribution.name,
          distribution.status,
          distribution.version,
          distribution.deployment.platforms.join(", "),
          permissionSummary(distribution.permissions),
        ]),
      )
      return 0
    }
    if (action === "show") {
      printJson(requireDistribution(store, parsed.positional[1]))
      return 0
    }
    if (action === "create") {
      const name = flag(parsed, "name") ?? parsed.positional[1]
      if (name === undefined) {
        throw new EnterpriseStoreError("Usage: omnia-server builds create <name> [--slug <slug>] [--description <text>]")
      }
      const slug = flag(parsed, "slug")
      const description = flag(parsed, "description")
      const distribution = store.createDistribution({
        name,
        ...(slug === undefined ? {} : { slug }),
        ...(description === undefined ? {} : { description }),
        actorId: CLI_ACTOR,
      })
      printJson(distribution)
      return 0
    }
    if (action === "update") {
      const distribution = requireDistribution(store, parsed.positional[1])
      const patch: Partial<ClientDistribution> = {}
      const name = flag(parsed, "name")
      if (name !== undefined) patch.name = name
      const slug = flag(parsed, "slug")
      if (slug !== undefined) patch.slug = slug
      const description = flag(parsed, "description")
      if (description !== undefined) patch.description = description
      const permissions = permissionsValue(parsed)
      if (permissions !== undefined) patch.permissions = { ...distribution.permissions, ...permissions }
      const features = featuresValue(parsed)
      if (features !== undefined) patch.features = { ...distribution.features, ...features }
      const platforms = csv(parsed, "platforms")
      const deployment = flag(parsed, "deployment")
      if (deployment !== undefined && !isNetworkMode(deployment)) {
        throw new EnterpriseStoreError("--deployment must be lan or public.")
      }
      if (platforms !== undefined || deployment !== undefined) {
        patch.deployment = {
          ...distribution.deployment,
          ...(platforms === undefined ? {} : { platforms: platforms.map(requirePlatform) }),
          ...(deployment === undefined ? {} : { mode: deployment }),
        }
      }
      const telemetry = toggle(parsed, "telemetry")
      if (telemetry !== undefined) patch.telemetry = { ...distribution.telemetry, enabled: telemetry }
      const defaultModel = flag(parsed, "default-model")
      const allowed = csv(parsed, "allow-model")
      const blocked = csv(parsed, "block-model")
      if (defaultModel !== undefined || allowed !== undefined || blocked !== undefined) {
        patch.models = {
          ...distribution.models,
          ...(defaultModel === undefined ? {} : { defaultModel }),
          ...(allowed === undefined ? {} : { allowed }),
          ...(blocked === undefined ? {} : { blocked }),
        }
      }
      if (Object.keys(patch).length === 0) {
        throw new EnterpriseStoreError(
          "No changes given. Pass --name, --slug, --description, --permission, --feature, --platforms, --deployment, --telemetry, --default-model, --allow-model or --block-model.",
        )
      }
      printJson(store.updateDistribution(distribution.id, patch, CLI_ACTOR))
      return 0
    }
    if (action === "publish") {
      const distribution = requireDistribution(store, parsed.positional[1])
      const version = flag(parsed, "version") ?? parsed.positional[2]
      if (version === undefined) {
        throw new EnterpriseStoreError("Usage: omnia-server builds publish <id|slug> --version <semver> [--notes <text>] [--notes-file <file>]")
      }
      const notesFile = flag(parsed, "notes-file")
      const notes = notesFile === undefined ? (flag(parsed, "notes") ?? "") : readFileSync(notesFile, "utf8")
      const updated = store.publishDistribution(distribution.id, version, notes, CLI_ACTOR)
      console.log(`Published ${updated.slug} ${updated.version}.`)
      console.log(`Manifest: ${consoleUrl(config)}/v1/enterprise/public/distributions/${updated.slug}/manifest`)
      return 0
    }
    if (action === "manifest") {
      const distribution = requireDistribution(store, parsed.positional[1])
      printJson(store.manifest(distribution, consoleUrl(config)))
      return 0
    }
    if (action === "feed") {
      const distribution = requireDistribution(store, parsed.positional[1])
      if (distribution.status !== "published") {
        throw new EnterpriseStoreError(`Publish ${distribution.slug} before clients can poll its update feed.`)
      }
      const manifest = store.manifest(distribution, consoleUrl(config))
      const url = `${consoleUrl(config)}/v1/enterprise/public/client/${encodeURIComponent(distribution.slug)}/update`
      const update = {
        version: manifest.version,
        ...(manifest.publishedAt === undefined ? {} : { publishedAt: manifest.publishedAt }),
        ...manifest.update,
        installers: manifest.deployment.installers,
      }
      if (bool(parsed, "json")) {
        printJson({ url, update })
        return 0
      }
      console.log(`Feed: ${url}`)
      console.log(`Version: ${manifest.version} (${manifest.update.channel} channel)`)
      if (manifest.update.minimumVersion !== undefined) console.log(`Minimum: ${manifest.update.minimumVersion}`)
      if (manifest.update.pinnedVersion !== undefined) console.log(`Pinned: ${manifest.update.pinnedVersion}`)
      for (const installer of manifest.deployment.installers) {
        console.log(`  ${installer.platform}  ${installer.kind}  ${installer.url}  ${installer.sha256 ?? "no checksum"}`)
      }
      return 0
    }
    if (action === "releases") {
      const distribution = requireDistribution(store, parsed.positional[1])
      const releases = store.releases(distribution.id)
      if (bool(parsed, "json")) {
        printJson(releases)
        return 0
      }
      if (releases.length === 0) {
        console.log(`No installers for ${distribution.slug} yet. Run \`omnia-server builds build ${distribution.slug}\`.`)
        return 0
      }
      table(
        ["ID", "PLATFORM", "VERSION", "STATUS", "SIZE", "STARTED", "ARTIFACT"],
        releases.map((release) => [
          release.id,
          release.platform,
          release.version,
          release.status,
          bytes(release.bytes),
          iso(release.startedAt),
          release.filename ?? release.error ?? "-",
        ]),
      )
      return 0
    }
    if (action === "build") {
      const distribution = requireDistribution(store, parsed.positional[1])
      const requested = values(parsed, "platform")
      const platforms = requested.length > 0 ? requested.map(requirePlatform) : distribution.deployment.platforms
      if (platforms.length === 0) throw new EnterpriseStoreError("This build lists no platforms. Pass --platform or update the build.")
      const farm = new ClientReleaseFarm({
        store,
        outputDir: join(config.dataDir, "releases"),
        ...(config.buildRoot === undefined ? {} : { root: config.buildRoot }),
      })
      const results = farm.start(distribution, platforms, CLI_ACTOR, consoleUrl(config))
      for (const result of results) {
        if (result.error === undefined) console.log(`  queued  ${result.release.platform}  ${result.release.id}`)
        else console.log(`  fail    ${result.release.platform}  ${result.error}`)
      }
      if (results.some((result) => result.error === undefined)) {
        console.log("\nBuilding. This can take several minutes; logs are kept in the console.")
        await farm.settled()
      }
      let failures = 0
      for (const result of results) {
        // Blocked targets were explained above; only report finished builds.
        if (result.error !== undefined) {
          failures += 1
          continue
        }
        const release = store.release(result.release.id)
        if (release === undefined) continue
        if (release.status === "ready") console.log(`  ready   ${release.platform}  ${release.filename ?? ""} (${bytes(release.bytes)})`)
        else {
          failures += 1
          console.log(`  fail    ${release.platform}  ${release.error ?? release.status}`)
        }
      }
      return failures === 0 ? 0 : 1
    }
    if (action === "installer") {
      const distribution = requireDistribution(store, parsed.positional[1])
      const platformKey = parsed.positional[2] ?? flag(parsed, "platform")
      if (platformKey === undefined) {
        throw new EnterpriseStoreError("Usage: omnia-server builds installer <id|slug> <platform> [--out <file>]")
      }
      const platform = requirePlatform(platformKey)
      const release = store.releaseFor(distribution, platform)
      if (release === undefined) throw new EnterpriseStoreError(`No ready ${platform} installer yet. Run \`omnia-server builds build ${distribution.slug}\`.`)
      const source = artifactPath(join(config.dataDir, "releases"), release)
      if (source === undefined || !existsSync(source)) {
        throw new EnterpriseStoreError("The release record has no artifact on disk; rebuild it.")
      }
      const destination =
        flag(parsed, "out") ?? join(process.cwd(), release.filename ?? `${distribution.slug}-${release.version}-${platform}`)
      copyFileSync(source, destination)
      store.appendAudit({
        action: "client.download",
        actorId: CLI_ACTOR,
        target: distribution.slug,
        metadata: { platform, artifact: "installer", version: release.version, bytes: release.bytes ?? 0 },
      })
      console.log(`Copied the ${platform} installer to ${destination}`)
      if (release.sha256 !== undefined) console.log(`sha256 ${release.sha256}`)
      return 0
    }
    if (action === "import") {
      const distribution = requireDistribution(store, parsed.positional[1])
      const platformKey = flag(parsed, "platform") ?? parsed.positional[2]
      if (platformKey === undefined) {
        throw new EnterpriseStoreError(
          "Usage: omnia-server builds import <id|slug> --platform <platform> --version <semver> --file <installer>",
        )
      }
      const platform = requirePlatform(platformKey)
      const version = flag(parsed, "version") ?? parsed.positional[3] ?? distribution.version
      const file = flag(parsed, "file")
      if (file === undefined) {
        throw new EnterpriseStoreError("Pass the installer to register with --file <path>.")
      }
      const source = resolve(file)
      if (!existsSync(source) || !statSync(source).isFile()) {
        throw new EnterpriseStoreError(`No installer file at ${source}.`)
      }
      // A platform this host cannot build is exactly the case this command
      // exists for: the artifact comes from a Mac or a Windows runner, and the
      // control plane only has to file it under the path the manifest points at.
      const filename = basename(source).replace(/[^A-Za-z0-9._-]+/g, "_") || `installer-${platform}`
      const directory = releaseDir(join(config.dataDir, "releases"), distribution.slug, version, platform)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const release = store.startRelease({
        distributionId: distribution.id,
        platform,
        version,
        actorId: CLI_ACTOR,
      })
      const destination = join(directory, filename)
      copyFileSync(source, destination)
      const size = statSync(destination).size
      const sha256 = createHash("sha256").update(readFileSync(destination)).digest("hex")
      store.completeRelease(release.id, { filename, bytes: size, sha256 })
      console.log(`Registered the ${platform} installer ${filename} (${bytes(size)}) for ${distribution.slug} ${version}.`)
      console.log(`sha256 ${sha256}`)
      console.log(`Release: ${release.id}`)
      return 0
    }
    if (action === "delete") {
      const distribution = requireDistribution(store, parsed.positional[1])
      if (!bool(parsed, "force")) {
        throw new EnterpriseStoreError(`Refusing to delete ${distribution.slug} without --force.`)
      }
      store.deleteDistribution(distribution.id, CLI_ACTOR)
      console.log(`Deleted ${distribution.slug} and its installers.`)
      return 0
    }
    throw new EnterpriseStoreError(`Unknown builds action: ${action}`)
  } catch (error) {
    return report(error)
  }
}

function policyCommand(parsed: Parsed): number {
  try {
    const { store } = openCliStore(parsed)
    const action = parsed.positional[0] ?? "show"
    if (action === "show") {
      printJson(store.policies())
      return 0
    }
    if (action !== "set") throw new EnterpriseStoreError(`Unknown policy action: ${action}`)

    const tools: Partial<Policies["tools"]> = {}
    const allowShell = toggle(parsed, "allow-shell")
    if (allowShell !== undefined) tools.allowShell = allowShell
    const allowFileWrite = toggle(parsed, "allow-file-write")
    if (allowFileWrite !== undefined) tools.allowFileWrite = allowFileWrite
    const allowNetwork = toggle(parsed, "allow-network")
    if (allowNetwork !== undefined) tools.allowNetwork = allowNetwork
    const allowComputerUse = toggle(parsed, "allow-computer-use")
    if (allowComputerUse !== undefined) tools.allowComputerUse = allowComputerUse
    const allowBrowser = toggle(parsed, "allow-browser")
    if (allowBrowser !== undefined) tools.allowBrowser = allowBrowser
    const allowSecrets = toggle(parsed, "allow-secrets")
    if (allowSecrets !== undefined) tools.allowSecrets = allowSecrets
    const approval = csv(parsed, "require-approval")
    if (approval !== undefined) tools.requireApprovalFor = approval

    const model: Partial<Policies["model"]> = {}
    const modelMode = flag(parsed, "model-mode")
    if (modelMode !== undefined) {
      if (modelMode !== "allowlist" && modelMode !== "denylist") {
        throw new EnterpriseStoreError("--model-mode must be allowlist or denylist.")
      }
      model.mode = modelMode
    }
    const models = csv(parsed, "models")
    if (models !== undefined) model.models = models
    const approveNew = toggle(parsed, "approve-new-models")
    if (approveNew !== undefined) model.requireApprovalForNewModels = approveNew

    const data: Partial<Policies["data"]> = {}
    const retention = numberValue(parsed, "retention-days")
    if (retention !== undefined) data.retentionDays = retention
    const allowTraining = toggle(parsed, "allow-training")
    if (allowTraining !== undefined) data.allowTraining = allowTraining
    const redactSecrets = toggle(parsed, "redact-secrets")
    if (redactSecrets !== undefined) data.redactSecrets = redactSecrets
    const blockPii = toggle(parsed, "block-pii-export")
    if (blockPii !== undefined) data.blockPiiExport = blockPii
    const encryption = toggle(parsed, "encryption-at-rest")
    if (encryption !== undefined) data.encryptionAtRest = encryption
    const byok = toggle(parsed, "byok")
    if (byok !== undefined) data.byok = byok
    const residency = flag(parsed, "residency")
    if (residency !== undefined) {
      if (residency !== "us" && residency !== "eu" && residency !== "apac" && residency !== "self-hosted") {
        throw new EnterpriseStoreError("--residency must be us, eu, apac or self-hosted.")
      }
      data.residency = residency
    }

    const audit: Partial<Policies["audit"]> = {}
    const auditRetention = numberValue(parsed, "audit-retention-days")
    if (auditRetention !== undefined) audit.retentionDays = auditRetention
    const exportFormat = flag(parsed, "export-format")
    if (exportFormat !== undefined) {
      if (exportFormat !== "json" && exportFormat !== "csv") throw new EnterpriseStoreError("--export-format must be json or csv.")
      audit.exportFormat = exportFormat
    }
    const siem = flag(parsed, "siem-webhook")
    if (siem !== undefined) audit.siemWebhook = siem

    const network: Partial<Policies["network"]> = {}
    const egress = csv(parsed, "egress-allowlist")
    if (egress !== undefined) network.egressAllowlist = egress
    const blockEgress = toggle(parsed, "block-public-egress")
    if (blockEgress !== undefined) network.blockPublicEgress = blockEgress

    const current = store.policies()
    const patch: Partial<Policies> = {
      ...(Object.keys(tools).length === 0 ? {} : { tools: { ...current.tools, ...tools } }),
      ...(Object.keys(model).length === 0 ? {} : { model: { ...current.model, ...model } }),
      ...(Object.keys(data).length === 0 ? {} : { data: { ...current.data, ...data } }),
      ...(Object.keys(audit).length === 0 ? {} : { audit: { ...current.audit, ...audit } }),
      ...(Object.keys(network).length === 0 ? {} : { network: { ...current.network, ...network } }),
    }
    const requireMfa = toggle(parsed, "require-mfa")
    if (requireMfa !== undefined) patch.requireMfa = requireMfa
    const sessionHours = numberValue(parsed, "session-hours")
    if (sessionHours !== undefined) patch.sessionHours = sessionHours
    const idleTimeout = numberValue(parsed, "idle-timeout")
    if (idleTimeout !== undefined) patch.idleTimeoutMinutes = idleTimeout
    const ipAllowlist = csv(parsed, "ip-allowlist")
    if (ipAllowlist !== undefined) patch.ipAllowlist = ipAllowlist

    if (Object.keys(patch).length === 0) {
      throw new EnterpriseStoreError(
        "No changes given. Pass --require-mfa, --session-hours, --allow-shell, --model-mode, --retention-days, --egress-allowlist, or another policy flag.",
      )
    }
    printJson(store.updatePolicies(patch, CLI_ACTOR))
    return 0
  } catch (error) {
    return report(error)
  }
}

function auditCommand(parsed: Parsed): number {
  try {
    const { store } = openCliStore(parsed)
    const action = parsed.positional[0] ?? "list"
    if (action === "list") {
      const limitFlag = numberValue(parsed, "limit")
      const events = store.audit(limitFlag === undefined ? 100 : Math.floor(limitFlag), undefined, flag(parsed, "action"))
      if (bool(parsed, "json")) {
        printJson(events)
        return 0
      }
      if (events.length === 0) {
        console.log("No audit events.")
        return 0
      }
      table(
        ["TIME", "ACTION", "ACTOR", "TARGET", "DETAIL"],
        events.map((event) => [
          iso(event.at),
          event.action,
          event.actorEmail ?? event.actorId ?? "system",
          event.target ?? "-",
          event.metadata === undefined ? "-" : JSON.stringify(event.metadata),
        ]),
      )
      return 0
    }
    if (action === "export") {
      const events = store.auditAll()
      const format = flag(parsed, "format") ?? store.policies().audit.exportFormat
      if (format !== "json" && format !== "csv") throw new EnterpriseStoreError("--format must be json or csv.")
      const body =
        format === "json"
          ? JSON.stringify(events, null, 2)
          : [
              "id,at,iso,action,actor_id,actor_email,target,ip,metadata",
              ...events.map((event) =>
                [
                  event.id,
                  String(event.at),
                  new Date(event.at).toISOString(),
                  event.action,
                  event.actorId ?? "",
                  event.actorEmail ?? "",
                  event.target ?? "",
                  event.ip ?? "",
                  event.metadata === undefined ? "" : JSON.stringify(event.metadata),
                ]
                  .map((cell) => `"${cell.replace(/"/g, '""')}"`)
                  .join(","),
              ),
            ].join("\n")
      const out = flag(parsed, "out")
      if (out === undefined) {
        console.log(body)
        return 0
      }
      writeFileSync(out, `${body}\n`, { mode: 0o600 })
      console.log(`Exported ${events.length} events to ${out} (${format}).`)
      return 0
    }
    throw new EnterpriseStoreError(`Unknown audit action: ${action}`)
  } catch (error) {
    return report(error)
  }
}

function usageCommand(parsed: Parsed): number {
  try {
    const { store } = openCliStore(parsed)
    const days = numberValue(parsed, "days") ?? 30
    const now = Date.now()
    const events = usageInWindow(store.usage(), days, now)
    const summary = {
      windowDays: days,
      ...totals(events),
      activeUsers: activeUsers(events),
      byDay: byDay(events, days, now),
      byModel: byModel(events),
      byUser: byUser(events, store.users()),
      byTool: byTool(events),
    }
    if (bool(parsed, "json")) {
      printJson(summary)
      return 0
    }
    console.log(`Usage · last ${days} days`)
    console.log(`  requests      ${summary.requests}`)
    console.log(`  tokens        ${summary.inputTokens} in / ${summary.outputTokens} out`)
    console.log(`  cost          $${summary.costUsd.toFixed(4)}`)
    console.log(`  active people ${summary.activeUsers}`)
    const sections: [string, typeof summary.byModel][] = [
      ["Models", summary.byModel],
      ["People", summary.byUser],
      ["Tools", summary.byTool],
    ]
    for (const [title, buckets] of sections) {
      if (buckets.length === 0) continue
      console.log(`\n${title}`)
      table(
        ["NAME", "REQUESTS", "INPUT", "OUTPUT", "COST"],
        buckets.map((bucket) => [
          bucket.key,
          String(bucket.requests),
          String(bucket.inputTokens),
          String(bucket.outputTokens),
          `$${bucket.costUsd.toFixed(4)}`,
        ]),
      )
    }
    return 0
  } catch (error) {
    return report(error)
  }
}

/** The subject of a ban command, from whichever identifier the operator gave. */
function legalSubject(parsed: Parsed): { kind: "account" | "installation"; value: string } | undefined {
  const email = flag(parsed, "email")
  const fingerprint = flag(parsed, "fingerprint")
  if (email !== undefined && fingerprint !== undefined) return undefined
  if (email !== undefined) return { kind: "account", value: email }
  if (fingerprint !== undefined) return { kind: "installation", value: fingerprint }
  return undefined
}

export function banCommand(parsed: Parsed): number {
  try {
    const subject = legalSubject(parsed)
    const reason = flag(parsed, "reason")?.trim()
    if (subject === undefined) {
      console.error("Usage: omnia-server ban --email <address> --reason <text>\n       omnia-server ban --fingerprint <id> --reason <text>")
      return 2
    }
    if (reason === undefined || reason.length === 0) {
      console.error("A ban needs --reason <text>: the text is shown on the banned installation.")
      return 2
    }
    const { store } = openCliStore(parsed)
    printJson(store.banLegalSubject({ ...subject, reason, createdBy: "cli" }))
    return 0
  } catch (error) {
    return report(error)
  }
}

export function unbanCommand(parsed: Parsed): number {
  try {
    const subject = legalSubject(parsed)
    if (subject === undefined) {
      console.error("Usage: omnia-server unban --email <address>\n       omnia-server unban --fingerprint <id>")
      return 2
    }
    const { store } = openCliStore(parsed)
    const lifted = store.liftLegalBan({ ...subject, liftedBy: "cli" })
    if (lifted === undefined) {
      console.log("No active ban matches that subject.")
      return 1
    }
    printJson(lifted)
    return 0
  } catch (error) {
    return report(error)
  }
}

export function bansCommand(parsed: Parsed): number {
  try {
    const { store } = openCliStore(parsed)
    const bans = store.legalBans().toSorted((left, right) => right.bannedAt - left.bannedAt)
    const active = bans.filter((ban) => ban.liftedAt === undefined)
    if (bool(parsed, "json")) {
      printJson({ active: active.length, bans })
      return 0
    }
    if (bans.length === 0) {
      console.log("No bans recorded.")
      return 0
    }
    table(
      ["SUBJECT", "KIND", "REASON", "APPLIED", "LIFTED"],
      bans.map((ban) => [
        ban.value,
        ban.kind,
        ban.reason,
        iso(ban.bannedAt),
        ban.liftedAt === undefined ? "-" : iso(ban.liftedAt),
      ]),
    )
    console.log(`\n${active.length} active of ${bans.length} recorded`)
    return 0
  } catch (error) {
    return report(error)
  }
}

export async function statusCommand(parsed: Parsed): Promise<number> {
  const home = homeDir(parsed)
  const runtime = readRuntime(home)
  const asJson = bool(parsed, "json")
  if (runtime === undefined) {
    if (asJson) printJson({ running: false })
    else console.log("omnia-server is not running (no runtime file).")
    return 1
  }
  if (!processAlive(runtime.pid)) {
    if (asJson) printJson({ running: false, stale: true, pid: runtime.pid })
    else console.log(`omnia-server is not running (pid ${runtime.pid} is gone).`)
    return 1
  }
  let health: { status: number; ok: boolean; version?: string; plan?: string } | undefined
  try {
    const response = await fetch(`${runtime.publicUrl}/v1/enterprise/public/health`, {
      signal: AbortSignal.timeout(3_000),
    })
    const body = (await response.json()) as { ok?: boolean; version?: string; plan?: string }
    health = {
      status: response.status,
      ok: body.ok === true,
      ...(body.version === undefined ? {} : { version: body.version }),
      ...(body.plan === undefined ? {} : { plan: body.plan }),
    }
  } catch {
    health = undefined
  }
  if (asJson) {
    printJson({
      running: true,
      pid: runtime.pid,
      startedAt: runtime.startedAt,
      consoleUrl: runtime.consoleUrl,
      publicUrl: runtime.publicUrl,
      health: health ?? { reachable: false },
    })
    return health !== undefined && health.ok ? 0 : 1
  }
  console.log(`omnia-server is running (pid ${runtime.pid}) since ${new Date(runtime.startedAt).toISOString()}.`)
  console.log(`  Console  ${runtime.consoleUrl}`)
  if (health === undefined) {
    console.log("  Health   unreachable")
    return 1
  }
  console.log(`  Health   ${health.status} · ${health.ok ? "ok" : "degraded"} · version ${health.version ?? "?"} · plan ${health.plan ?? "?"}`)
  return health.ok ? 0 : 1
}

export function stopCommand(parsed: Parsed): number {
  const home = homeDir(parsed)
  const runtime = readRuntime(home)
  if (runtime === undefined) {
    console.log("omnia-server is not running.")
    return 1
  }
  if (!processAlive(runtime.pid)) {
    rmSync(runtimePath(home), { force: true })
    console.log("omnia-server was not running; removed a stale runtime file.")
    return 0
  }
  process.kill(runtime.pid, "SIGTERM")
  console.log(`Sent SIGTERM to omnia-server (pid ${runtime.pid}).`)
  return 0
}

function versionCommand(): number {
  console.log(`omnia-server ${ENTERPRISE_VERSION} (enterprise)`)
  console.log(`omnia core   ${OMNIA_SERVER_VERSION}`)
  console.log(`bun          ${typeof Bun === "undefined" ? "unknown" : Bun.version}`)
  console.log(`platform     ${process.platform} ${process.arch}`)
  console.log(`started      ${new Date(STARTED_AT).toISOString()}`)
  return 0
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parse(argv)
  if (bool(parsed, "help") || parsed.command === "help") {
    console.log(HELP)
    return 0
  }
  switch (parsed.command) {
    case "init":
      return initCommand(parsed)
    case "start":
      return startCommand(parsed)
    case "doctor":
      return doctorCommand(parsed)
    case "config":
      return configCommand(parsed)
    case "users":
      return usersCommand(parsed)
    case "groups":
      return groupsCommand(parsed)
    case "invites":
      return invitesCommand(parsed)
    case "builds":
      return buildsCommand(parsed)
    case "policy":
      return policyCommand(parsed)
    case "audit":
      return auditCommand(parsed)
    case "usage":
      return usageCommand(parsed)
    case "token":
      return tokenCommand(parsed)
    case "license":
      return licenseCommand(parsed)
    case "ban":
      return banCommand(parsed)
    case "unban":
      return unbanCommand(parsed)
    case "bans":
      return bansCommand(parsed)
    case "status":
      return statusCommand(parsed)
    case "stop":
      return stopCommand(parsed)
    case "version":
      return versionCommand()
    default:
      console.error(`Unknown command: ${parsed.command}\n`)
      console.log(HELP)
      return 1
  }
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      if (error instanceof EnterpriseStoreError) console.error(error.message)
      else console.error(error instanceof Error ? error.stack ?? error.message : String(error))
      process.exit(1)
    },
  )
}

export { ENTERPRISE_VERSION }
