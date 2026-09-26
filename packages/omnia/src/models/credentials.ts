import { assertJsonValue, isRecord, type JsonObject, type JsonValue } from "./json"
import { InvalidModelRequestError } from "./errors"

export type CredentialSource = "env" | "secret" | "keychain" | "file" | "integration" | "custom" | (string & {})

export interface CredentialReference {
  readonly kind: "credential-reference"
  readonly id: string
  readonly source: CredentialSource
  readonly providerId?: string
  readonly version?: string
  readonly metadata?: JsonObject
}

export type CredentialRef = CredentialReference
export type CredentialReferenceInput = Omit<CredentialReference, "kind"> & {
  readonly kind?: "credential-reference"
}

export type CredentialResolver = (reference: CredentialReference) => string | undefined | Promise<string | undefined>

const secretField =
  /^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|client[-_]?secret|password|private[-_]?key|secret|token|value)$/i

function assertSafeCredentialInput(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new InvalidModelRequestError("Credential reference must be an object")
  if (Object.keys(value).some((key) => secretField.test(key))) {
    throw new InvalidModelRequestError("Credential references cannot contain plaintext secret fields")
  }
}

export function assertNoPlaintextSecrets(value: unknown, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPlaintextSecrets(item, `${path}[${index}]`))
    return
  }
  if (!isRecord(value)) return
  if (isCredentialReference(value)) return
  Object.entries(value).forEach(([key, item]) => {
    if (secretField.test(key)) throw new InvalidModelRequestError(`${path}.${key} cannot contain plaintext credentials`)
    assertNoPlaintextSecrets(item, `${path}.${key}`)
  })
}

export const isCredentialReference = (value: unknown): value is CredentialReference => {
  if (
    !isRecord(value) ||
    value.kind !== "credential-reference" ||
    typeof value.id !== "string" ||
    typeof value.source !== "string" ||
    (value.providerId !== undefined && (typeof value.providerId !== "string" || value.providerId.length === 0)) ||
    (value.version !== undefined && (typeof value.version !== "string" || value.version.length === 0))
  ) {
    return false
  }
  try {
    assertSafeCredentialInput(value)
    assertJsonValue(value)
    if (value.metadata !== undefined) assertNoPlaintextSecrets(value.metadata, "credential.metadata")
    return true
  } catch {
    return false
  }
}

export function createCredentialReference(input: CredentialReferenceInput): CredentialReference {
  assertSafeCredentialInput(input)
  if (typeof input.id !== "string" || input.id.length === 0) {
    throw new InvalidModelRequestError("Credential reference id must be a non-empty string")
  }
  if (typeof input.source !== "string" || input.source.length === 0) {
    throw new InvalidModelRequestError("Credential reference source must be a non-empty string")
  }
  if (input.providerId !== undefined && (typeof input.providerId !== "string" || input.providerId.length === 0)) {
    throw new InvalidModelRequestError("Credential reference providerId must be a non-empty string")
  }
  if (input.version !== undefined && (typeof input.version !== "string" || input.version.length === 0)) {
    throw new InvalidModelRequestError("Credential reference version must be a non-empty string")
  }
  if (input.metadata !== undefined) {
    assertJsonValue(input.metadata, "credential.metadata")
    assertNoPlaintextSecrets(input.metadata, "credential.metadata")
  }
  return {
    kind: "credential-reference",
    id: input.id,
    source: input.source,
    ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
    ...(input.version === undefined ? {} : { version: input.version }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  }
}

export const credentialFromEnvironment = (name: string, providerId?: string): CredentialReference =>
  createCredentialReference({ source: "env", id: name, ...(providerId === undefined ? {} : { providerId }) })

export const credentialFromSecret = (id: string, providerId?: string): CredentialReference =>
  createCredentialReference({ source: "secret", id, ...(providerId === undefined ? {} : { providerId }) })

export const credentialFromKeychain = (id: string, providerId?: string): CredentialReference =>
  createCredentialReference({ source: "keychain", id, ...(providerId === undefined ? {} : { providerId }) })

export interface CredentialResolutionContext {
  readonly reference: CredentialReference
  readonly providerId?: string
  readonly signal?: AbortSignal
}

export type CredentialResolverWithContext = (
  context: CredentialResolutionContext,
) => string | undefined | Promise<string | undefined>

export const credentialResolver =
  (resolver: CredentialResolverWithContext): CredentialResolver =>
  (reference) =>
    resolver({ reference, providerId: reference.providerId })

export const noCredentialResolver: CredentialResolver = () => undefined

export const assertCredentialReference = (value: unknown): CredentialReference => {
  if (!isCredentialReference(value)) throw new InvalidModelRequestError("Invalid credential reference")
  return value
}

export const credentialReferenceJson = (reference: CredentialReference): JsonValue => ({
  kind: reference.kind,
  id: reference.id,
  source: reference.source,
  ...(reference.providerId === undefined ? {} : { providerId: reference.providerId }),
  ...(reference.version === undefined ? {} : { version: reference.version }),
  ...(reference.metadata === undefined ? {} : { metadata: reference.metadata }),
})
