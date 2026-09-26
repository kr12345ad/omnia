export interface SuperskillSummary {
  id: string
  name: string
  description: string
  enabled: boolean
  version?: string
  author?: string
  bridgeType: "stdio" | "http"
  methods: string[]
}

export interface SuperskillMethod {
  name: string
  description: string
  parameters?: Record<string, unknown>
  scopes?: string[]
}

export interface SuperskillBridge {
  type: "stdio" | "http"
  command?: string
  url?: string
  env?: Record<string, string>
  timeoutMs?: number
}

export interface Superskill {
  id: string
  name: string
  description: string
  instructions: string
  enabled: boolean
  version?: string
  author?: string
  scopes?: string[]
  bridge: SuperskillBridge
  methods: SuperskillMethod[]
}

export interface SuperskillPlatform {
  list(): Promise<SuperskillSummary[]>
  get(id: string): Promise<Superskill>
  save(skill: Superskill): Promise<Superskill>
  remove(id: string): Promise<boolean>
  call(id: string, method: string, params: unknown): Promise<unknown>
}

export function emptySuperskill(): Superskill {
  return {
    id: "",
    name: "",
    description: "",
    instructions: "",
    enabled: true,
    bridge: { type: "stdio", command: "", timeoutMs: 30000 },
    methods: [{ name: "ping", description: "Return the given params.", parameters: { type: "object" } }],
  }
}
