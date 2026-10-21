import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { chmod, copyFile, mkdir, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { app } from "electron"
import { migrateOmniaStorage } from "./omnia-storage"
import { enterprisePermissionEnv, enterprisePermissions } from "./omnia/enterprise"

const execFileAsync = promisify(execFile)
const root = dirname(fileURLToPath(import.meta.url))

type Logger = {
  log(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

export async function startBackgroundCli(logger: Logger, _shellStateHome?: string) {
  // Read here, not at module load: the app assigns its own XDG_STATE_HOME
  // during startup, after this module has already been evaluated.
  const stateHome = process.env.XDG_STATE_HOME
  await migrateOmniaStorage(process.env.OPENCODE_DB!, process.env.OMNIA_LEGACY_DB)
  const bundled = app.isPackaged
    ? join(process.resourcesPath, executableName())
    : join(root, "../../resources", executableName())
  logger.log("v2 CLI executable resolved", { bundled, packaged: app.isPackaged })
  const version = await run(bundled, ["--version"], logger)
  const binary = app.isPackaged ? await installCli(bundled, version, logger) : bundled

  const candidates = [stateHome]
  // A candidate without a running service exits non-zero, and a state home
  // that disappears between the check and the probe fails to spawn: one
  // failing probe must not abort the whole startup.
  const discovered = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        return {
          stateHome: candidate,
          url: serviceUrl(await run(binary, ["service", "status"], logger, { stateHome: candidate })),
        }
      } catch {
        return { stateHome: candidate, url: undefined }
      }
    }),
  )
  const found = discovered.find((candidate) => candidate.url !== undefined)
  logger.log("v2 CLI background instance checked", {
    detected: Boolean(found),
    ...endpoint(found?.url),
  })

  // The v2 CLI service inherits this environment when it starts. A tenant build
  // must hand over its tool rules here too, not only through the v1 sidecar.
  const permissions = enterprisePermissionEnv()
  if (permissions !== undefined) {
    process.env.OPENCODE_PERMISSION = permissions
    process.env.OMNIA_COMPUTER_TOOLS = enterprisePermissions().computer === "deny" ? "0" : "1"
  }

  const daemonStateHome = found?.stateHome ?? stateHome
  const url = await run(binary, ["service", "start"], logger, { stateHome: daemonStateHome })
  const password = await run(binary, ["service", "get", "password"], logger, {
    redact: true,
    stateHome: daemonStateHome,
  })
  logger.log("v2 CLI background service ready", {
    existing: Boolean(found),
    username: "opencode",
    ...endpoint(url),
  })
  return {
    url,
    username: "opencode",
    password,
  }
}

async function installCli(source: string, version: string, logger: Logger) {
  const directory = join(app.getPath("userData"), "cli", version.replace(/[^a-zA-Z0-9._-]/g, "-"))
  const destination = join(directory, executableName())
  if (existsSync(destination)) {
    logger.log("v2 CLI staged executable reused", { path: destination, version })
    return destination
  }

  const temp = destination + `.${process.pid}.tmp`
  await mkdir(directory, { recursive: true })
  await copyFile(source, temp)
  if (process.platform !== "win32") await chmod(temp, 0o755)
  await rename(temp, destination).catch(async (error) => {
    await rm(temp, { force: true })
    throw error
  })
  logger.log("v2 CLI executable staged", { source, path: destination, version })
  return destination
}

async function run(
  binary: string,
  args: string[],
  logger: Logger,
  options: { redact?: boolean; stateHome?: string } = {},
) {
  logger.log("v2 CLI command started", { binary, args })
  const env = { ...process.env }
  if (options.stateHome === undefined) delete env.XDG_STATE_HOME
  else env.XDG_STATE_HOME = options.stateHome
  return execFileAsync(binary, args, { env, windowsHide: true }).then(
    (result) => {
      const stdout = result.stdout.trim()
      const stderr = result.stderr.trim()
      logger.log("v2 CLI command completed", { args, stdout: options.redact ? "[redacted]" : stdout, stderr })
      return stdout
    },
    (error: unknown) => {
      const output = error as { stdout?: string; stderr?: string }
      logger.error("v2 CLI command failed", {
        args,
        error: error instanceof Error ? error.message : String(error),
        stdout: options.redact && output.stdout ? "[redacted]" : (output.stdout?.trim() ?? ""),
        stderr: output.stderr?.trim() ?? "",
      })
      throw error
    },
  )
}

function serviceUrl(status: string) {
  if (URL.canParse(status)) return status
  if (!status.startsWith("running ")) return
  const url = status.slice("running ".length).trim()
  return URL.canParse(url) ? url : undefined
}

function endpoint(url: string | undefined) {
  if (!url || !URL.canParse(url)) return {}
  const parsed = new URL(url)
  return { url, hostname: parsed.hostname, port: parsed.port }
}

function executableName() {
  return process.platform === "win32" ? "opencode-cli.exe" : "opencode-cli"
}
