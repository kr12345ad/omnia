import type {
  ContentEnvelopeInput,
  ContentProvenance,
  ContentSource,
  DerivedContentEnvelopeInput,
  UntrustedContentEnvelope,
  UntrustedContentKind,
  UntrustedContentMetadata,
  UntrustedProvenance,
} from "./model"

export function createContentEnvelope(input: ContentEnvelopeInput): UntrustedContentEnvelope {
  const metadata = normalizeMetadata(input.provenance)
  return {
    _tag: "UntrustedContent",
    id: requireText(input.id, "content envelope id"),
    kind: contentKind(metadata.source.kind),
    channel: "tool",
    instruction: false,
    authority: "untrusted_data",
    trust: "untrusted",
    mediaType: requireText(input.mediaType, "content media type").toLowerCase(),
    content: input.content,
    provenance: securityProvenance(metadata.source),
    metadata,
  }
}

export function deriveContentEnvelope(
  parent: UntrustedContentEnvelope,
  input: DerivedContentEnvelopeInput,
): UntrustedContentEnvelope {
  if (!isUntrustedContentEnvelope(parent)) throw new TypeError("Derived content requires an untrusted content envelope")
  const id = requireText(input.id, "derived content envelope id")
  if (id === parent.id) throw new TypeError("Derived content envelope id must differ from its parent")
  const metadata: UntrustedContentMetadata = {
    observationId: parent.metadata.observationId,
    capturedAt: requireText(input.capturedAt, "content capture time"),
    capturedBy: requireText(input.capturedBy, "content capturer"),
    source: parent.metadata.source,
    ...(parent.metadata.revision === undefined ? {} : { revision: parent.metadata.revision }),
    ...(parent.metadata.elementId === undefined ? {} : { elementId: parent.metadata.elementId }),
    ...(parent.metadata.locator === undefined ? {} : { locator: parent.metadata.locator }),
    parentEnvelopeId: parent.id,
    ...(input.revision === undefined ? {} : { revision: input.revision }),
  }
  return {
    _tag: "UntrustedContent",
    id,
    kind: parent.kind,
    channel: "tool",
    instruction: false,
    authority: "untrusted_data",
    trust: "untrusted",
    mediaType: input.mediaType ?? parent.mediaType,
    content: input.content,
    provenance: securityProvenance(metadata.source, `${parent.id}:${id}`),
    metadata,
  }
}

export function isUntrustedContentEnvelope(value: unknown): value is UntrustedContentEnvelope {
  if (!isRecord(value)) return false
  if (value._tag !== "UntrustedContent" || value.authority !== "untrusted_data" || value.trust !== "untrusted")
    return false
  if (value.kind !== "application_content" && value.kind !== "file_content" && value.kind !== "web_content")
    return false
  if (value.channel !== "tool" || value.instruction !== false) return false
  if (typeof value.id !== "string" || typeof value.mediaType !== "string" || typeof value.content !== "string")
    return false
  if (!isUntrustedProvenance(value.provenance)) return false
  if (!isRecord(value.metadata)) return false
  if (
    typeof value.metadata.observationId !== "string" ||
    typeof value.metadata.capturedAt !== "string" ||
    typeof value.metadata.capturedBy !== "string" ||
    !isContentSource(value.metadata.source)
  )
    return false
  if (value.provenance.source !== securitySource(value.metadata.source)) return false
  return contentKind(value.metadata.source.kind) === value.kind
}

function normalizeMetadata(input: ContentProvenance): UntrustedContentMetadata {
  return {
    observationId: requireText(input.observationId, "content observation id"),
    capturedAt: requireText(input.capturedAt, "content capture time"),
    capturedBy: requireText(input.capturedBy, "content capturer"),
    source: normalizeContentSource(input.source),
    ...(input.revision === undefined ? {} : { revision: requireText(input.revision, "content revision") }),
    ...(input.elementId === undefined ? {} : { elementId: requireText(input.elementId, "content element id") }),
    ...(input.locator === undefined ? {} : { locator: input.locator }),
    ...(input.parentEnvelopeId === undefined
      ? {}
      : { parentEnvelopeId: requireText(input.parentEnvelopeId, "parent content envelope id") }),
  }
}

function normalizeContentSource(input: ContentSource): ContentSource {
  if (input.kind === "application")
    return {
      kind: "application",
      id: requireText(input.id, "application id"),
      ...optionalText("windowId", input.windowId),
      ...optionalText("title", input.title),
    }
  if (input.kind === "web")
    return {
      kind: "web",
      url: requireText(input.url, "web URL"),
      ...optionalText("frameUrl", input.frameUrl),
      ...optionalText("title", input.title),
    }
  if (input.kind === "file")
    return {
      kind: "file",
      path: requireText(input.path, "file path"),
      ...optionalText("name", input.name),
    }
  throw new TypeError("Content source must be application, web, or file data")
}

function securityProvenance(source: ContentSource, derivation?: string): UntrustedProvenance {
  const sourceName = securitySource(source)
  const origin = source.kind === "application" ? source.id : source.kind === "web" ? source.url : source.path
  return {
    source: sourceName,
    trust: "untrusted",
    authority: "none",
    origin: derivation === undefined ? origin : `${origin}#${derivation}`,
  }
}

function securitySource(source: ContentSource) {
  return source.kind === "web" ? ("webpage" as const) : source.kind
}

function isUntrustedProvenance(value: unknown): value is UntrustedProvenance {
  if (!isRecord(value)) return false
  if (
    value.source !== "application" &&
    value.source !== "environment" &&
    value.source !== "file" &&
    value.source !== "webpage"
  )
    return false
  if (value.trust !== "untrusted" || value.authority !== "none") return false
  return value.origin === undefined || typeof value.origin === "string"
}

function contentKind(source: ContentSource["kind"]): UntrustedContentKind {
  if (source === "application") return "application_content"
  if (source === "file") return "file_content"
  return "web_content"
}

function isContentSource(value: unknown): value is ContentSource {
  if (!isRecord(value)) return false
  if (value.kind === "application") return typeof value.id === "string"
  if (value.kind === "web") return typeof value.url === "string"
  if (value.kind === "file") return typeof value.path === "string"
  return false
}

function optionalText<Key extends string>(key: Key, value: string | undefined) {
  if (value === undefined || !value.trim()) return {}
  return { [key]: value }
}

function requireText(value: string, kind: string) {
  if (!value.trim()) throw new TypeError(`Expected a non-empty ${kind}`)
  return value
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
