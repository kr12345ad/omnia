import type {
  InstructionAuthority,
  Provenance,
  ProvenanceInput,
  ProvenanceSource,
  TrustLevel,
} from "./types"

const trustedSources = new Set<ProvenanceSource>(["user", "operator", "system"])
const untrustedSources = new Set<ProvenanceSource>([
  "application",
  "file",
  "webpage",
  "tool",
  "environment",
  "retrieved",
  "memory",
  "computer",
  "vision",
  "model",
  "remote",
  "virtual",
  "accessibility",
  "dom",
  "ocr",
  "hybrid",
  "native",
  "browser",
  "unknown",
])

const normalizeSource = (source: string): ProvenanceSource => {
  const value = source.trim().toLowerCase()
  if (value === "human") return "user"
  if (value === "human_user") return "user"
  if (value === "web") return "webpage"
  if (value === "file_content") return "file"
  if (value === "app") return "application"
  if (value === "tool_output") return "tool"
  if (value === "retrieval") return "retrieved"
  return (trustedSources.has(value as ProvenanceSource) || untrustedSources.has(value as ProvenanceSource)
    ? value
    : "unknown") as ProvenanceSource
}

const trustForSource = (source: ProvenanceSource): TrustLevel => {
  if (source === "system") return "system"
  return trustedSources.has(source) ? "trusted" : "untrusted"
}

const authorityForSource = (source: ProvenanceSource): InstructionAuthority => {
  if (source === "user") return "user"
  if (source === "operator") return "operator"
  if (source === "system") return "system"
  return "none"
}

export class UntrustedInstructionError extends Error {
  readonly code = "untrusted_instruction"

  constructor(readonly source: ProvenanceSource) {
    super(`Content from ${source} cannot be treated as a user instruction`)
    this.name = "UntrustedInstructionError"
  }
}

export function makeProvenance(
  input: ProvenanceInput | undefined,
  options: { readonly origin?: string; readonly metadata?: Readonly<Record<string, unknown>> } = {},
): Provenance {
  const source = normalizeSource(typeof input === "string" ? input : input?.source ?? "unknown")
  const suppliedTrust = typeof input === "string" ? undefined : input?.trust
  const expectedTrust = trustForSource(source)
  const trust = suppliedTrust === "untrusted" ? "untrusted" : expectedTrust
  const suppliedAuthority = typeof input === "string" ? undefined : input?.authority
  const authority = trust === "untrusted" ? "none" : (suppliedAuthority ?? authorityForSource(source))
  const origin = options.origin ?? (typeof input === "string" ? undefined : input?.origin)
  const metadata = options.metadata ?? (typeof input === "string" ? undefined : input?.metadata)
  return Object.freeze({
    source,
    trust,
    authority,
    ...(origin === undefined ? {} : { origin }),
    ...(metadata === undefined ? {} : { metadata: Object.freeze({ ...metadata }) }),
  })
}

export const provenanceFromSource = makeProvenance

export function trustedProvenance(
  source: "user" | "operator" | "system" = "operator",
  origin?: string,
): Provenance {
  return makeProvenance(source, origin === undefined ? {} : { origin })
}

export function untrustedProvenance(source: ProvenanceSource = "unknown", origin?: string): Provenance {
  return makeProvenance(
    { source, trust: "untrusted", authority: "none" },
    origin === undefined ? {} : { origin },
  )
}

export function isTrustedProvenance(value: ProvenanceInput | undefined): boolean {
  const provenance = makeProvenance(value)
  return provenance.trust === "trusted" || provenance.trust === "system"
}

export function isUntrustedProvenance(value: ProvenanceInput | undefined): boolean {
  return makeProvenance(value).trust === "untrusted"
}

export function isUserInstructionSource(value: ProvenanceInput | undefined): boolean {
  const provenance = makeProvenance(value)
  return provenance.source === "user" && provenance.trust === "trusted" && provenance.authority === "user"
}

export function canBeUserInstruction(value: ProvenanceInput | undefined): boolean {
  return isUserInstructionSource(value)
}

export function canBeInstruction(value: ProvenanceInput | undefined): boolean {
  return isTrustedProvenance(value)
}

export function classifyInstruction(value: ProvenanceInput | undefined): {
  readonly outcome: "allowed" | "blocked"
  readonly authority: InstructionAuthority
  readonly reason: string
} {
  const provenance = makeProvenance(value)
  if (isUserInstructionSource(provenance)) return { outcome: "allowed", authority: "user", reason: "user instruction" }
  if (provenance.source === "operator" || provenance.source === "system") {
    if (provenance.trust === "trusted" || provenance.trust === "system") {
      return { outcome: "allowed", authority: provenance.authority, reason: `${provenance.source} instruction` }
    }
  }
  return {
    outcome: "blocked",
    authority: "none",
    reason: `content from ${provenance.source} is data, not an instruction`,
  }
}

export function classifyProvenance(value: ProvenanceInput | undefined): {
  readonly source: ProvenanceSource
  readonly trust: TrustLevel
  readonly authority: InstructionAuthority
  readonly instruction: "allowed" | "blocked"
  readonly channel: "user" | "system" | "tool"
} {
  const provenance = makeProvenance(value)
  const instruction = classifyInstruction(provenance)
  return {
    source: provenance.source,
    trust: provenance.trust,
    authority: provenance.authority,
    instruction: instruction.outcome,
    channel: instruction.outcome === "allowed" ? (provenance.authority === "user" ? "user" : "system") : "tool",
  }
}

export function assertUserInstruction(value: ProvenanceInput | undefined): Provenance {
  const provenance = makeProvenance(value)
  if (!isUserInstructionSource(provenance)) throw new UntrustedInstructionError(provenance.source)
  return provenance
}

export function withProvenance(
  parent: ProvenanceInput,
  child: ProvenanceInput,
  options: { readonly origin?: string; readonly metadata?: Readonly<Record<string, unknown>> } = {},
): Provenance {
  const parentProvenance = makeProvenance(parent)
  const childProvenance = makeProvenance(child)
  if (parentProvenance.trust === "untrusted" || childProvenance.trust === "untrusted") {
    const origin = options.origin ?? childProvenance.origin
    return makeProvenance(
      { source: childProvenance.source, trust: "untrusted", authority: "none", ...(origin === undefined ? {} : { origin }) },
      options.metadata === undefined ? {} : { metadata: options.metadata },
    )
  }
  return makeProvenance(childProvenance, {
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
  })
}

export function provenanceTrust(value: ProvenanceInput | undefined): TrustLevel {
  return makeProvenance(value).trust
}

export function provenanceSource(value: ProvenanceInput | undefined): ProvenanceSource {
  return makeProvenance(value).source
}

export const trustSource = provenanceTrust
export const isTrusted = isTrustedProvenance
export const isUntrusted = isUntrustedProvenance
export const isUserInstruction = isUserInstructionSource
export const trusted = trustedProvenance
export const untrusted = untrustedProvenance
export const sourceProvenance = makeProvenance
export const deriveProvenance = withProvenance
