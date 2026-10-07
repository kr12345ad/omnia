import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import type { Specialist } from "./types.js"
import { validateRoster, type RosterValidation } from "./validate.js"

export const SPECIALISTS_FILE_VERSION = 1

export function defaultSpecialistsFile(): string {
  return join(homedir(), ".local", "share", "omnia", "specialists.json")
}

export interface SpecialistStoreOptions {
  readonly file?: string
}

export class SpecialistStore {
  private readonly file: string

  constructor(options: SpecialistStoreOptions = {}) {
    this.file = options.file ?? defaultSpecialistsFile()
  }

  get path(): string {
    return this.file
  }

  load(): Specialist[] | undefined {
    const stat = lstatOrUndefined(this.file)
    if (stat === undefined || !stat.isFile()) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown
    } catch {
      return undefined
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    const result = validateRoster((parsed as Record<string, unknown>).specialists)
    return result.ok ? result.specialists : undefined
  }

  save(input: unknown): RosterValidation {
    const result = validateRoster(input)
    if (!result.ok) return result
    const existing = lstatOrUndefined(this.file)
    if (existing !== undefined && !existing.isFile()) {
      return { ok: false, error: "The specialists file is not a regular file and was not overwritten." }
    }
    const directory = dirname(this.file)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporary = join(directory, `.${basename(this.file)}.${randomUUID()}.tmp`)
    try {
      const handle = openSync(temporary, "wx", 0o600)
      try {
        writeFileSync(handle, JSON.stringify({ version: SPECIALISTS_FILE_VERSION, specialists: result.specialists }, null, 2))
        fsyncSync(handle)
      } finally {
        closeSync(handle)
      }
      renameSync(temporary, this.file)
    } catch (error) {
      try {
        unlinkSync(temporary)
      } catch {
        // Already gone, or the directory is gone with it.
      }
      throw error
    }
    chmodSync(this.file, 0o600)
    return result
  }

  reset(): void {
    rmSync(this.file, { force: true })
  }
}

function lstatOrUndefined(file: string) {
  try {
    return lstatSync(file)
  } catch {
    return undefined
  }
}
