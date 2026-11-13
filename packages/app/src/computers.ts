export type ComputerCredentialKind = "password" | "username_password" | "token"

export type ComputerCredentialRuleKind = "command" | "application" | "url"

export interface ComputerCredentialRule {
  kind: ComputerCredentialRuleKind
  match: string
}

export interface ComputerCredentialSummary {
  id: string
  computerId: string
  name: string
  kind: ComputerCredentialKind
  username?: string
  rules: ComputerCredentialRule[]
  description?: string
  enabled: boolean
  createdAt: number
  updatedAt: number
  hasSecret: boolean
}

export interface ComputerCredentialInput {
  id?: string
  computerId: string
  name: string
  kind?: ComputerCredentialKind
  username?: string
  secret?: string
  rules?: ComputerCredentialRule[]
  description?: string
  enabled?: boolean
}

export interface ComputerSummary {
  id: string
  name: string
  platform: string
  architecture?: string
  backend: string
  driver: string
  connected: boolean
  lastSeen?: number
}

export interface ComputerControlResult {
  success: boolean
  status?: string
  message?: string
}

export interface ComputerPairing {
  code: string
  expiresAt: number
  serverUrl: string
  pairingCode?: string
  command?: string
}

export interface ComputerPairJoinResult {
  computerId: string
  serverUrl: string
  name?: string
}

export interface ComputerPairStatus {
  paired: boolean
  computerId?: string
  serverUrl?: string
  connected?: boolean
}

export interface ComputerControlPlane {
  url: string | null
}

export interface ComputerPlatform {
  list(): Promise<ComputerSummary[]>
  stop(computerId: string, reason?: string): Promise<ComputerControlResult>
  connect(computerId: string): Promise<ComputerControlResult>
  rename(computerId: string, name: string): Promise<ComputerSummary>
  pair: {
    create(name?: string): Promise<ComputerPairing>
    cancel(code: string): Promise<boolean>
    join(code: string): Promise<ComputerPairJoinResult>
    leave(): Promise<boolean>
    status(): Promise<ComputerPairStatus>
  }
  controlPlane: {
    get(): Promise<ComputerControlPlane>
    set(url: string | null): Promise<ComputerControlPlane>
  }
  credentials: {
    list(computerId: string): Promise<ComputerCredentialSummary[]>
    save(input: ComputerCredentialInput): Promise<ComputerCredentialSummary>
    remove(computerId: string, id: string): Promise<boolean>
  }
}

export function emptyCredential(computerId: string): ComputerCredentialInput {
  return {
    computerId,
    name: "",
    kind: "password",
    username: "",
    secret: "",
    rules: [{ kind: "command", match: "sudo" }],
    enabled: true,
  }
}
