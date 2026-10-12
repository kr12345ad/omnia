import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs"
import { dirname } from "node:path"
import { computeAim } from "../computer-use/aim"
import type { JsonValue } from "../protocol"
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

// Computer-use audit record
// -------------------------
// One record per computer-use action, carrying everything the reliability
// contract (docs/computer-use-reliability.md) requires of an audit trail: which
// observation the target came from, the aim point and the strategy that chose
// it, which window a window action addressed, who permitted the action, and
// what a post-action read actually showed.
//
// `aim.strategy === "bounds-center"` is a recorded guess, never a precise
// target: the element exposed no focus point, no provider hint and no role that
// identifies an actionable region, so the centre of the bounding box was the
// only point available (contract rule 2).

/** The point a pointer action was aimed at, and how that point was chosen. */
export interface ComputerUseAim {
  readonly x: number
  readonly y: number
  readonly strategy: string
}

/** Who allowed a computer-use action, when, and under which scopes. */
export interface ComputerUsePermission {
  readonly allowed: boolean
  readonly status: "allowed" | "prompt" | "denied"
  /** The approving caller: `desktop`, `agent`, or the caller's own approvedBy. */
  readonly by?: string
  readonly at: number
  readonly scopes?: readonly string[]
}

/** What the post-action read showed, against what was expected. */
export interface ComputerUseOutcome {
  readonly status: "verified" | "not_verified"
  readonly expected?: JsonValue
  readonly observed?: JsonValue
  readonly method?: string
  readonly reason?: string
}

export interface ComputerUseRecord extends SecurityRecord {
  readonly type: "computer_use.action"
  readonly computerId: string
  readonly action: string
  readonly observationId?: string
  readonly generation?: number
  /** The element ref the action targeted, when it targeted one. */
  readonly ref?: string
  /** The semantic query the caller used when it carried no ref. */
  readonly query?: string
  /** Accessible name of the resolved element, for a readable trail. */
  readonly target?: string
  /**
   * The window a window action addressed, by title: the title the execution's
   * resolved window carries, or the title the request named.
   */
  readonly window?: string
  /** The window element id the execution was delivered to. */
  readonly windowId?: string
  readonly aim?: ComputerUseAim
  readonly permission: ComputerUsePermission
  readonly result: ComputerUseOutcome
}

const COMPUTER_USE_RECORD_TYPE = "computer_use.action"
const MAX_REASON_CHARS = 600

function isComputerUseRecord(value: unknown): value is ComputerUseRecord {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  if (record.type !== COMPUTER_USE_RECORD_TYPE) return false
  if (typeof record.action !== "string" || typeof record.computerId !== "string") return false
  if (typeof record.permission !== "object" || record.permission === null) return false
  const result = record.result
  if (typeof result !== "object" || result === null) return false
  const status = (result as Record<string, unknown>).status
  return status === "verified" || status === "not_verified"
}

// The action as the caller asked for it. Structural on purpose: the journal
// does not depend on the server's request type, and the caller keeps ownership
// of what it parsed out of the request.
export interface ComputerUseActionInput {
  readonly action: string
  readonly ref?: string
  readonly query?: string
  /** The window title the request named, for a window action. */
  readonly window?: string
  readonly observationId?: string
  readonly generation?: number
  readonly x?: number
  readonly y?: number
  readonly approvedBy?: string
  readonly origin?: "desktop" | "agent"
  readonly sessionId?: string
}

export interface ComputerUseElementInput {
  readonly id?: string
  readonly role?: string
  readonly name?: string
  readonly bounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface ComputerUseObservationInput {
  readonly id?: string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly elements?: readonly ComputerUseElementInput[]
}

export interface ComputerUseResultInput {
  readonly message?: string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly verification?: {
    readonly status?: string
    readonly method?: string
    readonly expected?: JsonValue
    readonly actual?: JsonValue
    readonly message?: string
    readonly evidence?: readonly { readonly kind?: string; readonly value?: JsonValue }[]
  }
  readonly observation?: ComputerUseObservationInput
  /** An ActionResult error, which the protocol allows to be a bare string. */
  readonly error?: unknown
  readonly evidence?: readonly { readonly kind?: string; readonly value?: JsonValue }[]
}

export interface ComputerUseExecutionInput {
  readonly computerId: string
  readonly serverId: string
  readonly at: number
  readonly request: ComputerUseActionInput
  readonly outcome: ComputerUseResultInput
  /** Scopes the gate required for this action, from requiredScopesForAction. */
  readonly scopes?: readonly string[]
  /** Observations read before and after the action, for aim resolution. */
  readonly before?: ComputerUseObservationInput
  readonly after?: ComputerUseObservationInput
}

function numberField(source: Readonly<Record<string, unknown>> | undefined, key: string): number | undefined {
  const value = source?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function observationGeneration(observation: ComputerUseObservationInput | undefined): number | undefined {
  const snapshot = numberField(observation?.metadata, "generation")
  if (snapshot !== undefined) return snapshot
  const element = observation?.elements?.find((entry) => numberField(entry.metadata, "generation") !== undefined)
  return element === undefined ? undefined : numberField(element.metadata, "generation")
}

function findElement(
  observations: readonly (ComputerUseObservationInput | undefined)[],
  ref: string | undefined,
): ComputerUseElementInput | undefined {
  if (ref === undefined || ref.length === 0) return undefined
  for (const observation of observations) {
    const element = observation?.elements?.find((entry) => entry.id === ref)
    if (element !== undefined) return element
  }
  return undefined
}

function aimFor(
  request: ComputerUseActionInput,
  element: ComputerUseElementInput | undefined,
): ComputerUseAim | undefined {
  // A window is raised or focused, never aimed at, so a point inside its bounds
  // would be an invented aim rather than a chosen one; a window action names
  // the window instead (see windowTargetOf).
  //
  // A resolved element is aimed from its own metadata, so the strategy names
  // the evidence the point came from and a bounds-center result stays a guess.
  if (element?.bounds !== undefined && element.role !== "window") {
    const aim = computeAim({ bounds: element.bounds, ...(element.role === undefined ? {} : { role: element.role }) })
    return { x: aim.x, y: aim.y, strategy: aim.strategy }
  }
  // Bare pixel coordinates are the canvas/unknown-surface path (rule 6). They
  // are recorded as what they are instead of being dressed up as an element aim.
  if (request.x !== undefined && request.y !== undefined) return { x: request.x, y: request.y, strategy: "pixel" }
  return undefined
}

function truncate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return value.length <= MAX_REASON_CHARS ? value : `${value.slice(0, MAX_REASON_CHARS)}…`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorField(error: unknown, key: "code" | "message"): string | undefined {
  if (!isRecord(error)) return undefined
  const value = error[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

// A window action reaches the manager as a title and is resolved inside it, so
// the window the action was delivered to is read from the execution's own
// resolved target: the window element id and the title that element carries.
// The trail writes nothing it was not handed — a request that resolved no
// window leaves both fields absent, and the title it still records is the one
// the request named.
function windowTargetOf(
  outcome: ComputerUseResultInput,
): { readonly windowId: string; readonly title?: string } | undefined {
  const resolved = outcome.metadata?.["target"]
  if (!isRecord(resolved) || resolved["role"] !== "window") return undefined
  const id = resolved["ref"]
  if (typeof id !== "string" || id.length === 0) return undefined
  const name = resolved["name"]
  return { windowId: id, ...(typeof name === "string" && name.length > 0 ? { title: name } : {}) }
}

// A semantic query is resolved to an element inside the manager, so the request
// the journal sees carries the query and not the ref. The server's own
// target-scoped verification names the element it verified against, which is
// the ref the query resolved to; it is taken from there and nowhere else, so a
// guess is never written into the trail as a ref.
function refFromEvidence(
  verification: ComputerUseResultInput["verification"],
): string | undefined {
  for (const entry of verification?.evidence ?? []) {
    if (entry?.kind !== "state-changes" || typeof entry.value !== "string") continue
    try {
      const parsed: unknown = JSON.parse(entry.value)
      if (isRecord(parsed) && typeof parsed.target === "string" && parsed.target.length > 0) return parsed.target
    } catch {
      // Not the machine-readable shape; the next entry is tried.
    }
  }
  return undefined
}

/**
 * Build the journal record for one executed computer-use action.
 *
 * The verdict is `verified` only when the execution's own verification says so;
 * everything else - including "the action reported success with no readback" -
 * is `not_verified` with what was expected and what was read attached.
 */
export function computerUseRecord(input: ComputerUseExecutionInput): ComputerUseRecord {
  const request = input.request
  const outcome = input.outcome
  const verification = outcome.verification
  const requestedRef = request.ref === undefined || request.ref.length === 0 ? undefined : request.ref
  const query = request.query === undefined || request.query.length === 0 ? undefined : request.query
  const observationId =
    request.observationId === undefined || request.observationId.length === 0
      ? undefined
      : request.observationId
  const ref = requestedRef ?? refFromEvidence(verification)
  const element = findElement([input.before, input.after, outcome.observation], ref)
  const errorCode = errorField(outcome.error, "code")
  // A refusal is a permission outcome, not a failed action: the gate either
  // denied the scope outright ("denied") or it is waiting for an approval
  // ("prompt"), and both are recorded as such rather than as a click that
  // happened.
  const refused = errorCode === "permission_denied" || errorCode === "permission_required"
  const aim = aimFor(request, element)
  // A window action is traced by the window it was delivered to: the title the
  // resolved window carries, falling back to the title the request named.
  const windowTarget = windowTargetOf(outcome)
  const namedWindow = request.window === undefined || request.window.length === 0 ? undefined : request.window
  const window = truncate(windowTarget?.title ?? namedWindow)
  // Generation is the target's document generation when the caller did not bind
  // one, so a stale ref is visible in the trail instead of being invisible.
  const generation =
    request.generation ?? observationGeneration(input.before) ?? observationGeneration(outcome.observation)
  const reason = truncate(
    verification?.message ?? errorField(outcome.error, "message") ?? (typeof outcome.error === "string" ? outcome.error : undefined) ?? outcome.message,
  )
  return {
    type: COMPUTER_USE_RECORD_TYPE,
    at: input.at,
    serverId: input.serverId,
    computerId: input.computerId,
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    action: request.action,
    ...(observationId === undefined ? {} : { observationId }),
    ...(generation === undefined ? {} : { generation }),
    ...(element?.name === undefined ? {} : { target: element.name }),
    ...(ref === undefined ? {} : { ref }),
    ...(query === undefined ? {} : { query }),
    ...(window === undefined ? {} : { window }),
    ...(windowTarget === undefined ? {} : { windowId: windowTarget.windowId }),
    ...(aim === undefined ? {} : { aim }),
    permission: {
      allowed: !refused,
      status: refused ? (errorCode === "permission_denied" ? "denied" : "prompt") : "allowed",
      ...(request.approvedBy === undefined ? {} : { by: request.approvedBy }),
      ...(request.approvedBy === undefined && request.origin !== undefined ? { by: request.origin } : {}),
      at: input.at,
      ...(input.scopes === undefined ? {} : { scopes: [...input.scopes] }),
    },
    result: {
      status: verification?.status === "verified" ? "verified" : "not_verified",
      ...(verification?.expected === undefined ? {} : { expected: verification.expected }),
      ...(verification?.actual === undefined ? {} : { observed: verification.actual }),
      ...(verification?.method === undefined ? {} : { method: verification.method }),
      ...(reason === undefined ? {} : { reason }),
    },
  }
}

/**
 * Write one computer-use record to the journal, and report whether it landed.
 *
 * The single writer of computer-use records. The manager boundary that journals
 * the action routes and the semantic service, and the Cua engine route that
 * reaches its driver directly, both journal through here, so a field recorded
 * by one path can never be dropped by another and the trail cannot grow a
 * second opinion about what an action was.
 *
 * A failure - capacity, a closed journal, a filesystem error - is reported to
 * the caller, which is what fails the audit subsystem closed. It never changes
 * the action's own result, and it is never swallowed here: a caller that
 * ignored the answer would turn an unjournaled action into an invisible one.
 */
export function appendComputerUseRecord(journal: SecurityJournal, input: ComputerUseExecutionInput): boolean {
  try {
    journal.append(computerUseRecord(input))
    return true
  } catch {
    return false
  }
}

export interface ComputerUseTrailFilter {
  readonly computerId?: string
  readonly since?: number
  readonly limit?: number
}

/** Whether the chain the reader walked is intact, broken, or unreadable. */
export type ComputerUseChainStatus = "ok" | "broken" | "unavailable"

export interface ComputerUseTrail {
  readonly records: readonly ComputerUseRecord[]
  readonly chain: ComputerUseChainStatus
  /** How many journal rows the MAC chain covered before the reader stopped. */
  readonly verifiedThrough: number
  /** Matching computer-use records in the file, before `limit` was applied. */
  readonly total: number
  readonly error?: string
}

const MAX_TRAIL_LIMIT = 1000
const DEFAULT_TRAIL_LIMIT = 200

// A file this reader will touch at all: a private, owner-only regular file that
// is not a symlink. The same rule the writer enforces, checked here because a
// journal readable by anyone else is not a trail to hand out. The descriptor is
// closed before any refusal, so a failed check never leaks one.
function openPrivateFile(file: string): number | undefined {
  let fd: number
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return undefined
  }
  let privateFile = false
  try {
    const info = fstatSync(fd)
    privateFile =
      info.isFile() &&
      info.nlink === 1 &&
      (process.platform === "win32" || (info.mode & 0o077) === 0) &&
      (process.getuid === undefined || info.uid === process.getuid())
  } catch {
    privateFile = false
  }
  if (!privateFile) {
    closeSync(fd)
    return undefined
  }
  return fd
}

function readPrivateFile(file: string): string | undefined {
  const fd = openPrivateFile(file)
  if (fd === undefined) return undefined
  try {
    return readFileSync(fd, "utf8")
  } catch {
    return undefined
  } finally {
    closeSync(fd)
  }
}

// Raw bytes, never text: a journal key is 32 random bytes, and a utf8 round
// trip would silently rewrite it and break every MAC it produces.
function journalKey(file: string): Buffer | undefined {
  const fd = openPrivateFile(`${file}.key`)
  if (fd === undefined) return undefined
  try {
    const key = readFileSync(fd)
    return key.length === 32 ? key : undefined
  } catch {
    return undefined
  } finally {
    closeSync(fd)
  }
}

/**
 * Read the computer-use records out of a security journal, re-deriving the HMAC
 * chain as it goes.
 *
 * Read-only: the journal file and its key are opened without the writer's lock,
 * so a running server is never disturbed, and nothing here can append or
 * rotate. A chain that does not verify stops the walk rather than returning
 * records that cannot be trusted, and the records already collected are
 * returned with `chain: "broken"` so a caller can tell the difference between
 * "no actions" and "actions that cannot be proven".
 */
export function readComputerUseTrail(file: string, filter: ComputerUseTrailFilter = {}): ComputerUseTrail {
  const limit = Math.max(1, Math.min(MAX_TRAIL_LIMIT, Math.floor(filter.limit ?? DEFAULT_TRAIL_LIMIT)))
  const content = readPrivateFile(file)
  if (content === undefined) {
    return { records: [], chain: "ok", verifiedThrough: 0, total: 0 }
  }
  const key = journalKey(file)
  if (key === undefined) {
    return {
      records: [],
      chain: "unavailable",
      verifiedThrough: 0,
      total: 0,
      error: "The security journal key is missing or unreadable, so the chain cannot be verified.",
    }
  }
  const computerId =
    filter.computerId === undefined || filter.computerId.length === 0 ? undefined : filter.computerId
  const since = filter.since
  const matches: ComputerUseRecord[] = []
  let verifiedThrough = 0
  let previous = ROOT
  let chain: ComputerUseChainStatus = "ok"
  let error: string | undefined
  const rows = content.split("\n")
  for (let index = 0; index < rows.length; index += 1) {
    const line = rows[index]!
    if (line.length === 0) continue
    let row: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object")
      row = parsed as Record<string, unknown>
    } catch {
      chain = "broken"
      error = `The security journal line ${index + 1} is not a JSON object.`
      break
    }
    const expected = createHmac("sha256", key)
      .update(JSON.stringify({ sequence: row.sequence, previous: row.previous, record: row.record }))
      .digest("hex")
    if (row.sequence !== verifiedThrough + 1 || row.previous !== previous || typeof row.mac !== "string" ||
      row.mac.length !== expected.length || !timingSafeEqual(Buffer.from(row.mac), Buffer.from(expected))) {
      chain = "broken"
      error = `The security journal chain does not verify at line ${index + 1}.`
      break
    }
    verifiedThrough += 1
    previous = row.mac
    const record = row.record
    if (!isComputerUseRecord(record)) continue
    if (computerId !== undefined && record.computerId !== computerId) continue
    if (since !== undefined && record.at < since) continue
    matches.push(record)
  }
  return {
    records: matches.slice(Math.max(0, matches.length - limit)),
    chain,
    verifiedThrough,
    total: matches.length,
    ...(error === undefined ? {} : { error }),
  }
}

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
