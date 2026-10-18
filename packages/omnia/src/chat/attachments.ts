// Files a chat platform delivered with a message. The platform hands over a
// reference and the auth it takes to read it, so the bytes are fetched only
// when a turn actually starts -- never a URL the sender typed. What a model can
// use is limited on purpose: an image is handed to the provider, text is inlined
// by opencode, and anything else is named in the prompt instead of being sent
// as bytes the model cannot read.

import type { RunFile } from "../agent-run/runner"
import type { ChatAttachment } from "./service"

/** A turn is billed and bounded, so a message cannot attach an unbounded pile. */
export const ATTACHMENT_LIMIT = 5
/** Larger than this and the provider refuses it or the upload times out. */
export const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024

const IMAGE = /^image\/(png|jpe?g|gif|webp)$/i
const TEXTUAL = /^text\/|^application\/(json|xml|x-yaml|yaml|csv)$/i

const BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain",
  md: "text/plain",
  log: "text/plain",
  csv: "text/csv",
  json: "application/json",
  yaml: "application/x-yaml",
  yml: "application/x-yaml",
  xml: "application/xml",
}

/** What a model can actually be given: a picture, or text opencode can inline. */
export function attachmentKind(mime: string, name = ""): "image" | "text" | undefined {
  const type = mime.trim().length > 0 ? mime : mimeFromName(name)
  if (IMAGE.test(type)) return "image"
  if (TEXTUAL.test(type)) return "text"
  return undefined
}

/** A platform that omits the content type still names the file. */
export function mimeFromName(name: string): string {
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : ""
  return BY_EXTENSION[extension] ?? "application/octet-stream"
}

/**
 * Fetch one attachment into a data: URL. Undefined means it cannot be used --
 * refused, empty, or over the size a model turn may carry -- and the turn goes
 * on without it rather than failing on a file nobody asked about.
 */
export async function fetchAttachment(
  url: string,
  options: { readonly headers?: Readonly<Record<string, string>>; readonly maxBytes?: number } = {},
): Promise<string | undefined> {
  const max = options.maxBytes ?? ATTACHMENT_MAX_BYTES
  const response = await fetch(url, {
    headers: options.headers ?? {},
    signal: AbortSignal.timeout(30_000),
  }).catch(() => undefined)
  if (response === undefined || !response.ok) return undefined
  const declared = Number(response.headers.get("content-length") ?? "")
  if (Number.isFinite(declared) && declared > max) return undefined
  const bytes = new Uint8Array(await response.arrayBuffer().catch(() => new ArrayBuffer(0)))
  if (bytes.byteLength === 0 || bytes.byteLength > max) return undefined
  const mime = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? ""
  return `data:${mime.length === 0 ? "application/octet-stream" : mime};base64,${Buffer.from(bytes).toString("base64")}`
}

export interface ChatFiles {
  /** What the turn carries, in the order the message attached them. */
  readonly files: readonly RunFile[]
  /** Named in the prompt so the answer can admit what it could not see. */
  readonly skipped: readonly string[]
}

export async function readAttachments(attachments: readonly ChatAttachment[] | undefined): Promise<ChatFiles> {
  const offered = (attachments ?? []).slice(0, ATTACHMENT_LIMIT)
  const skipped = (attachments ?? []).slice(ATTACHMENT_LIMIT).map((attachment) => attachment.name)
  const loaded = await Promise.all(
    offered.map(async (attachment): Promise<RunFile | undefined> => {
      const kind = attachmentKind(attachment.mime, attachment.name)
      if (kind === undefined) {
        skipped.push(attachment.name)
        return undefined
      }
      const url = await attachment.load().catch(() => undefined)
      if (url === undefined || url.length === 0) {
        skipped.push(attachment.name)
        return undefined
      }
      // text/* is normalized so opencode inlines it as a text part; any other
      // textual subtype would be handed to the provider as a file instead.
      return { mime: kind === "text" ? "text/plain" : attachment.mime, filename: attachment.name, url }
    }),
  )
  return { files: loaded.filter((file): file is RunFile => file !== undefined), skipped }
}
