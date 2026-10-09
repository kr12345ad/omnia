import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs"
import { dirname } from "node:path"
import { redactSecrets } from "./redaction"

export interface SecurityRecord {
  readonly type: string
  readonly at: number
  readonly serverId: string
  readonly method?: string
  readonly route?: string
  readonly status?: number
  readonly address?: string
  readonly actor?: string
  readonly computerId?: string
  readonly sessionId?: string
}

const ROOT = "0".repeat(64)
export const MAX_SECURITY_JOURNAL_BYTES = 64 * 1024 * 1024
const MAX_RECORD_BYTES = 8 * 1024

/** Single-writer, append-only JSONL with an authenticated chain. No clear API.
 * The local key is private, not a protection against the process owner; export
 * chain heads to an independent collector to detect suffix deletion/rollback.
 */
export class SecurityJournal {
  private readonly key: Buffer
  private readonly fd: number
  private readonly lock: number
  private sequence = 0
  private previous = ROOT
  private closed = false

  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    this.lock = openSync(`${file}.lock`, "wx", 0o600)
    try {
      const keyFile = `${file}.key`
      try {
        const fd = openSync(keyFile, "wx", 0o600)
        try {
          const key = randomBytes(32)
          writeSync(fd, key)
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error
      }
      const keyFd = openSync(keyFile, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        this.assertPrivateFile(keyFd)
        this.key = readFileSync(keyFd)
        if (this.key.length !== 32) throw new Error("Invalid security journal key.")
      } finally {
        closeSync(keyFd)
      }
      this.fd = openSync(file, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
      try {
        this.assertPrivateFile(this.fd)
        if (fstatSync(this.fd).size > MAX_SECURITY_JOURNAL_BYTES) throw new Error("Security journal capacity exceeded.")
        fchmodSync(this.fd, 0o600)
        const content = readFileSync(this.fd, "utf8")
        if (content.length && !content.endsWith("\n")) throw new Error("Incomplete security journal record.")
        for (const line of content.split("\n").filter(Boolean)) {
          const row: unknown = JSON.parse(line)
          if (typeof row !== "object" || row === null || !("sequence" in row) || !("previous" in row) || !("record" in row) || !("mac" in row)) {
            throw new Error("Invalid security journal record.")
          }
          const payload = { sequence: row.sequence, previous: row.previous, record: row.record }
          const expected = this.mac(payload)
          if (row.sequence !== this.sequence + 1 || row.previous !== this.previous || typeof row.mac !== "string" ||
            row.mac.length !== expected.length || !timingSafeEqual(Buffer.from(row.mac), Buffer.from(expected))) {
            throw new Error("Security journal integrity check failed.")
          }
          this.sequence += 1
          this.previous = row.mac
        }
      } catch (error) {
        closeSync(this.fd)
        throw error
      }
    } catch (error) {
      closeSync(this.lock)
      unlinkSync(`${file}.lock`)
      throw error
    }
  }

  private assertPrivateFile(fd: number): void {
    const info = fstatSync(fd)
    // Windows privacy is owned by the user-data directory ACL, not POSIX mode
    // bits. Unix platforms require both owner and 0600-style permissions.
    if (!info.isFile() || info.nlink !== 1 || (process.platform !== "win32" && (info.mode & 0o077) !== 0) ||
      (process.getuid !== undefined && info.uid !== process.getuid())) {
      throw new Error("Security journal files must be private, owned regular files.")
    }
  }

  private mac(payload: object): string {
    return createHmac("sha256", this.key).update(JSON.stringify(payload)).digest("hex")
  }

  append(record: SecurityRecord): string {
    if (this.closed) throw new Error("Security journal is closed.")
    const payload = { sequence: this.sequence + 1, previous: this.previous, record: redactSecrets(record) }
    const mac = this.mac(payload)
    const bytes = Buffer.from(`${JSON.stringify({ ...payload, mac })}\n`)
    if (bytes.length > MAX_RECORD_BYTES || fstatSync(this.fd).size + bytes.length > MAX_SECURITY_JOURNAL_BYTES) {
      throw new Error("Security journal capacity exceeded; archive and rotate before resuming.")
    }
    let offset = 0
    while (offset < bytes.length) offset += writeSync(this.fd, bytes, offset)
    fsyncSync(this.fd)
    this.sequence = payload.sequence
    this.previous = mac
    return mac
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    closeSync(this.fd)
    closeSync(this.lock)
    unlinkSync(`${this.file}.lock`)
  }
}
