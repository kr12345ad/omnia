import type { ProtoTypedValue } from "./types"

export function jsonIetfValue(value: unknown): ProtoTypedValue {
  return { json_ietf_val: Buffer.from(JSON.stringify(value)) }
}

/**
 * Read a string leaf from a Set update. JSON_IETF is the advertised encoding,
 * so a typed string arrives either as string_val or as a JSON string in
 * json_ietf_val. ASCII is accepted because it is unambiguous and some clients
 * still emit it for leaf updates.
 */
export function readStringValue(value: ProtoTypedValue | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value.string_val === "string") return value.string_val
  if (typeof value.ascii_val === "string") return value.ascii_val
  const encoded = value.json_ietf_val ?? value.json_val
  if (encoded !== undefined) {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(encoded).toString("utf8"))
      return typeof parsed === "string" ? parsed : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}
