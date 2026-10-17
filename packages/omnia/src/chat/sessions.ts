// Which agent session a chat conversation continues, and which model it
// answers with.
//
// A Discord channel, DM or thread is one conversation: the first message opens
// a session and every later message in the same place continues it. The mapping
// is the server's, not the platform's, so it survives a gateway reconnect and
// a restart of the control plane. A model chosen with /models sits beside it and
// outlives /new: the conversation keeps its model when it starts over.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const DEFAULT_FILE = join(homedir(), ".local/share/omnia/chat-sessions.json")

interface ConversationBinding {
  readonly sessionId: string
  readonly updatedAt: number
}

export interface ConversationModel {
  readonly providerID: string
  readonly modelID: string
}

interface ModelBinding extends ConversationModel {
  readonly updatedAt: number
}

interface SessionStoreFile {
  readonly conversations: Record<string, ConversationBinding>
  readonly models: Record<string, ModelBinding>
}

function empty(): SessionStoreFile {
  return { conversations: {}, models: {} }
}

function load(file: string): SessionStoreFile {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown
    if (typeof parsed !== "object" || parsed === null) return empty()
    return {
      conversations: readConversations((parsed as { conversations?: unknown }).conversations),
      models: readModels((parsed as { models?: unknown }).models),
    }
  } catch {
    return empty()
  }
}

function readConversations(value: unknown): Record<string, ConversationBinding> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  const valid = Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
    if (typeof entry !== "object" || entry === null) return []
    const sessionId = (entry as { sessionId?: unknown }).sessionId
    if (typeof sessionId !== "string" || sessionId.length === 0) return []
    const updatedAt = (entry as { updatedAt?: unknown }).updatedAt
    return [[key, { sessionId, updatedAt: typeof updatedAt === "number" ? updatedAt : 0 }] as const]
  })
  return Object.fromEntries(valid)
}

function readModels(value: unknown): Record<string, ModelBinding> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  const valid = Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
    if (typeof entry !== "object" || entry === null) return []
    const model = entry as { providerID?: unknown; modelID?: unknown; updatedAt?: unknown }
    if (typeof model.providerID !== "string" || model.providerID.length === 0) return []
    if (typeof model.modelID !== "string" || model.modelID.length === 0) return []
    return [
      [
        key,
        {
          providerID: model.providerID,
          modelID: model.modelID,
          updatedAt: typeof model.updatedAt === "number" ? model.updatedAt : 0,
        },
      ] as const,
    ]
  })
  return Object.fromEntries(valid)
}

export class ChatSessionStore {
  private readonly file: string
  private store: SessionStoreFile

  constructor(options: { file?: string } = {}) {
    this.file = options.file ?? DEFAULT_FILE
    this.store = load(this.file)
  }

  /** The conversation key: a channel, DM or thread on one platform. */
  get(key: string): string | undefined {
    return this.store.conversations[key]?.sessionId
  }

  bind(key: string, sessionId: string): void {
    this.store = {
      ...this.store,
      conversations: { ...this.store.conversations, [key]: { sessionId, updatedAt: Date.now() } },
    }
    this.save()
  }

  clear(key: string): boolean {
    if (this.store.conversations[key] === undefined) return false
    const conversations = { ...this.store.conversations }
    delete conversations[key]
    this.store = { ...this.store, conversations }
    this.save()
    return true
  }

  /** The model this conversation answers with, if one was chosen with /models. */
  getModel(key: string): ConversationModel | undefined {
    const bound = this.store.models[key]
    return bound === undefined ? undefined : { providerID: bound.providerID, modelID: bound.modelID }
  }

  setModel(key: string, model: ConversationModel): void {
    this.store = {
      ...this.store,
      models: { ...this.store.models, [key]: { ...model, updatedAt: Date.now() } },
    }
    this.save()
  }

  /** Forget the choice so the conversation follows the server default again. */
  clearModel(key: string): boolean {
    if (this.store.models[key] === undefined) return false
    const models = { ...this.store.models }
    delete models[key]
    this.store = { ...this.store, models }
    this.save()
    return true
  }

  keys(): readonly string[] {
    return Object.keys(this.store.conversations)
  }

  modelKeys(): readonly string[] {
    return Object.keys(this.store.models)
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.store, null, 2), { mode: 0o600 })
  }
}
