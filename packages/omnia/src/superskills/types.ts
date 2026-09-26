import type { OmniaScope } from "../server/permissions"

export interface SuperskillMethod {
  readonly name: string
  readonly description: string
  readonly parameters?: Readonly<Record<string, unknown>>
  readonly scopes?: readonly OmniaScope[]
}

export interface SuperskillBridge {
  readonly type: "stdio" | "http"
  readonly command?: string
  readonly url?: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}

// A superskill combines UI knowledge with a JSON-RPC bridge: the instructions
// teach the model how to use the software, and the bridge exposes deterministic
// methods for the parts where an interface is not enough.
export interface Superskill {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly instructions: string
  readonly enabled: boolean
  readonly version?: string
  readonly author?: string
  readonly scopes?: readonly OmniaScope[]
  readonly bridge: SuperskillBridge
  readonly methods: readonly SuperskillMethod[]
}

export interface SuperskillSummary {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly enabled: boolean
  readonly version?: string
  readonly author?: string
  readonly bridgeType: "stdio" | "http"
  readonly methods: readonly string[]
}
