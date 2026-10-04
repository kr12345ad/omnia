import { randomUUID } from "node:crypto"
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"

export const CREDENTIAL_KINDS = ["password", "username_password", "token"] as const

export type CredentialKind = (typeof CREDENTIAL_KINDS)[number]

export const CREDENTIAL_RULE_KINDS = ["command", "application", "url"] as const

export type CredentialRuleKind = (typeof CREDENTIAL_RULE_KINDS)[number]

export interface CredentialRule {
  readonly kind: CredentialRuleKind
  readonly match: string
}

export interface ComputerCredential {
  readonly id: string
  readonly computerId: string
  readonly name: string
  readonly kind: CredentialKind
  readonly username?: string
  readonly secret: string
  readonly rules: readonly CredentialRule[]
  readonly description?: string
  readonly enabled: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

export type ComputerCredentialSummary = Omit<ComputerCredential, "secret"> & { readonly hasSecret: boolean }

export interface CredentialInput {
  readonly id?: string
  readonly computerId: string
  readonly name: string
  readonly kind?: CredentialKind
  readonly username?: string
  readonly secret?: string
  readonly rules?: readonly CredentialRule[]
  readonly description?: string
  readonly enabled?: boolean
}

export interface CredentialQuery {
  readonly computerId: string
  readonly command?: string
  readonly application?: string
  readonly url?: string
}

export interface CredentialMatch {
  readonly credential: ComputerCredential
  readonly rule: CredentialRule
  readonly score: number
}

export interface CredentialStoreOptions {
  readonly file?: string
  readonly now?: () => number
}

export const CREDENTIAL_FILE_VERSION = 1

export const CREDENTIAL_ENV_KEYS = {
  username: "OMNIA_CREDENTIAL_USERNAME",
  password: "OMNIA_CREDENTIAL_PASSWORD",
  token: "OMNIA_CREDENTIAL_TOKEN",
} as const

export function defaultCredentialFile(): string {
  return join(homedir(), ".local/share/omnia/credentials.json")
}

export function isCredentialKind(value: unknown): value is CredentialKind {
  return typeof value === "string" && (CREDENTIAL_KINDS as readonly string[]).includes(value)
}

export function isCredentialRuleKind(value: unknown): value is CredentialRuleKind {
  return typeof value === "string" && (CREDENTIAL_RULE_KINDS as readonly string[]).includes(value)
}

export function summarizeCredential(credential: ComputerCredential): ComputerCredentialSummary {
  const { secret, ...rest } = credential
  return { ...rest, hasSecret: secret.length > 0 }
}

export function credentialEnv(credential: ComputerCredential): Record<string, string> {
  const env: Record<string, string> = {}
  if (credential.kind === "username_password" && credential.username !== undefined) {
    env[CREDENTIAL_ENV_KEYS.username] = credential.username
  }
  if (credential.kind === "token") env[CREDENTIAL_ENV_KEYS.token] = credential.secret
  else env[CREDENTIAL_ENV_KEYS.password] = credential.secret
  return env
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let value = text
  for (const secret of secrets) {
    // Short secrets must be redacted too; only an empty string is skipped
    // because splitting on it would corrupt the text.
    if (secret.length === 0) continue
    value = value.split(secret).join("[redacted]")
  }
  return value
}

// Matching is word-bounded so a short rule such as "rm" or "gh" cannot inject
// a stored secret into an unrelated command like "format" or "ghostscript".
function wordBoundaryMatch(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, "i").test(text)
}

function ruleScore(rule: CredentialRule, query: CredentialQuery): number | undefined {
  const term = rule.match.trim()
  const match = term.toLowerCase()
  if (match.length === 0) return undefined
  if (rule.kind === "command") {
    if (query.command === undefined) return undefined
    return wordBoundaryMatch(query.command, match) ? match.length : undefined
  }
  if (rule.kind === "application") {
    if (query.application === undefined) return undefined
    return wordBoundaryMatch(query.application, match) ? match.length : undefined
  }
  if (query.url === undefined) return undefined
  return urlRuleScore(term, query.url)
}

// A URL rule is matched on parsed identity, never on a string prefix: raw
// `startsWith` makes `https://portal.example` authorize
// `https://portal.example.evil.tld` and `https://portal.example@evil.tld`, so
// `credential:"auto"` would type a stored secret into an attacker page.
// Scheme, host, port, and any rule path must match; a rule path only matches on
// a `/` boundary, so `/admin` never authorizes `/administrator`.
function urlRuleScore(term: string, url: string): number | undefined {
  if (!URL.canParse(term) || !URL.canParse(url)) return undefined
  const rule = new URL(term)
  const target = new URL(url)
  // Userinfo is a display trick, never an identity: a rule carrying it is
  // ambiguous by construction and never matches.
  if (rule.username !== "" || rule.password !== "") return undefined
  if (rule.protocol !== target.protocol || rule.hostname !== target.hostname) return undefined
  // The port is part of the origin, so it has to match too. A rule that omits
  // it means the scheme default, which URL drops from both sides, so
  // `https://app.example.com` still covers `https://app.example.com:443/login`
  // while never reaching a service listening on another port.
  if (rule.port !== target.port) return undefined
  // A rule that scopes by query or fragment must match it exactly instead of
  // silently widening to the whole host.
  if ((rule.search !== "" || rule.hash !== "") && (rule.search !== target.search || rule.hash !== target.hash)) {
    return undefined
  }
  return rulePathCovers(rule.pathname, target.pathname) ? term.length : undefined
}

function rulePathCovers(rulePath: string, path: string): boolean {
  if (rulePath === "" || rulePath === "/") return true
  if (!path.startsWith(rulePath)) return false
  if (rulePath.endsWith("/")) return true
  return path.length === rulePath.length || path.charAt(rulePath.length) === "/"
}

function kindRank(kind: CredentialRuleKind): number {
  if (kind === "command") return 0
  if (kind === "application") return 1
  return 2
}

function credentialRecords(source: string): unknown[] | undefined {
  let data: unknown
  try {
    data = JSON.parse(source) as unknown
  } catch {
    return undefined
  }
  if (typeof data !== "object" || data === null) return undefined
  const records = (data as { credentials?: unknown }).credentials
  return Array.isArray(records) ? records : undefined
}

function parseCredential(value: unknown): ComputerCredential | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.id !== "string" || record.id.length === 0) return undefined
  if (typeof record.computerId !== "string" || record.computerId.length === 0) return undefined
  if (typeof record.name !== "string" || record.name.length === 0) return undefined
  if (!isCredentialKind(record.kind)) return undefined
  if (typeof record.secret !== "string") return undefined
  const rules = Array.isArray(record.rules)
    ? record.rules.flatMap((rule): CredentialRule[] => {
        if (typeof rule !== "object" || rule === null) return []
        const entry = rule as Record<string, unknown>
        if (!isCredentialRuleKind(entry.kind) || typeof entry.match !== "string") return []
        return [{ kind: entry.kind, match: entry.match }]
      })
    : []
  return {
    id: record.id,
    computerId: record.computerId,
    name: record.name,
    kind: record.kind,
    ...(typeof record.username === "string" ? { username: record.username } : {}),
    secret: record.secret,
    rules,
    ...(typeof record.description === "string" ? { description: record.description } : {}),
    enabled: record.enabled !== false,
    createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : Date.now(),
  }
}

export class CredentialStore {
  private credentials: ComputerCredential[] = []
  private readonly file: string
  private readonly now: () => number

  constructor(options: CredentialStoreOptions = {}) {
    this.file = options.file ?? defaultCredentialFile()
    this.now = options.now ?? Date.now
    this.load()
  }

  private load(): void {
    let parsed: string
    try {
      parsed = readFileSync(this.file, "utf8")
    } catch (error) {
      // A missing file is a fresh install. Any other read failure leaves bytes
      // this process never saw, and starting empty would let the next save
      // replace them, so they are quarantined instead.
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) this.quarantine()
      return
    }
    if (parsed.trim().length === 0) return
    const records = credentialRecords(parsed)
    if (records === undefined) {
      // A torn or truncated write must never masquerade as an empty vault:
      // move it aside so the bytes survive the next save and stay recoverable.
      this.quarantine()
      return
    }
    this.credentials = records.flatMap((record) => {
      const credential = parseCredential(record)
      return credential === undefined ? [] : [credential]
    })
  }

  private persist(): void {
    const directory = dirname(this.file)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporary = join(directory, `.${basename(this.file)}.${randomUUID()}.tmp`)
    try {
      // The vault is written to a private temp file first: `wx` never follows
      // an attacker-planted symlink, and 0600 never exposes the secrets even
      // for the instant the file exists.
      const handle = openSync(temporary, "wx", 0o600)
      try {
        writeFileSync(handle, JSON.stringify({ version: CREDENTIAL_FILE_VERSION, credentials: this.credentials }, null, 2))
        fsyncSync(handle)
      } finally {
        closeSync(handle)
      }
      // rename(2) inside one directory is atomic, so a crash or a full disk
      // leaves either the previous vault or this one, never a half-written mix.
      renameSync(temporary, this.file)
    } catch (error) {
      // A temp file left behind is dead weight holding secrets; never keep one.
      try {
        unlinkSync(temporary)
      } catch {
        // Already gone, or the directory is gone with it.
      }
      throw error
    }
    try {
      fsyncDirectory(directory)
    } catch {
      // The rename already landed; only its durability across a power loss is
      // weakened, which must not be reported as a failed save.
    }
  }

  // Keeps a corrupt vault instead of letting the next save destroy it.
  private quarantine(): void {
    try {
      renameSync(this.file, `${this.file}.corrupt`)
    } catch {
      // Nothing to preserve, or the directory is not writable.
    }
  }

  list(computerId?: string): readonly ComputerCredential[] {
    return this.credentials.filter(
      (credential) => computerId === undefined || credential.computerId === computerId || credential.computerId === "*",
    )
  }

  summaries(computerId?: string): readonly ComputerCredentialSummary[] {
    return this.list(computerId).map(summarizeCredential)
  }

  get(id: string): ComputerCredential | undefined {
    return this.credentials.find((credential) => credential.id === id)
  }

  save(input: CredentialInput): ComputerCredential {
    const existing = input.id === undefined ? undefined : this.get(input.id)
    const timestamp = this.now()
    const username = input.username ?? existing?.username
    const description = input.description ?? existing?.description
    const credential: ComputerCredential = {
      id: existing?.id ?? randomUUID(),
      computerId: input.computerId,
      name: input.name,
      kind: input.kind ?? existing?.kind ?? "password",
      ...(username === undefined ? {} : { username }),
      secret: input.secret ?? existing?.secret ?? "",
      rules: input.rules ?? existing?.rules ?? [],
      ...(description === undefined ? {} : { description }),
      enabled: input.enabled ?? existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    }
    this.credentials = existing === undefined
      ? [...this.credentials, credential]
      : this.credentials.map((candidate) => (candidate.id === credential.id ? credential : candidate))
    this.persist()
    return credential
  }

  remove(id: string): boolean {
    const next = this.credentials.filter((credential) => credential.id !== id)
    if (next.length === this.credentials.length) return false
    this.credentials = next
    this.persist()
    return true
  }

  match(query: CredentialQuery): CredentialMatch | undefined {
    const candidates = this.credentials.flatMap((credential) => {
      if (!credential.enabled) return []
      if (credential.computerId !== "*" && credential.computerId !== query.computerId) return []
      return credential.rules.flatMap((rule): CredentialMatch[] => {
        const score = ruleScore(rule, query)
        return score === undefined ? [] : [{ credential, rule, score }]
      })
    })
    // Rule kind is the specificity signal (an explicit command beats a
    // window title beats a page URL), so it ranks before match length. A long
    // unrelated url rule must never outrank a short exact application rule.
    candidates.sort(
      (a, b) =>
        kindRank(a.rule.kind) - kindRank(b.rule.kind) ||
        b.score - a.score ||
        b.credential.updatedAt - a.credential.updatedAt,
    )
    return candidates[0]
  }
}

// The rename that swapped the vault in is only durable once the directory
// entry itself is on disk.
function fsyncDirectory(directory: string): void {
  const handle = openSync(directory, "r")
  try {
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
}
