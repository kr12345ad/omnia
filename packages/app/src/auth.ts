export interface GitHubProfile {
  id: number
  login: string
  name?: string
  avatarUrl?: string
  email?: string
  htmlUrl?: string
}

export interface GitHubDevicePrompt {
  userCode: string
  verificationUri: string
  expiresAt: number
}

export interface GitHubAuthStatus {
  authenticated: boolean
  profile?: GitHubProfile
  method?: "oauth" | "gh"
  signedInAt?: number
  ghAvailable: boolean
  pending?: GitHubDevicePrompt
  oauthClientConfigured?: boolean
  callbackPath?: string
}

export interface GitHubAuthStartResult {
  status: GitHubAuthStatus
  authorizeUrl?: string
  redirectUri?: string
  device?: GitHubDevicePrompt
}

export interface GitHubAuthPlatform {
  status(): Promise<GitHubAuthStatus>
  start(method?: "browser" | "device" | "loopback" | "gh"): Promise<GitHubAuthStartResult>
  logout(): Promise<GitHubAuthStatus>
  saveClient(clientId: string, clientSecret?: string): Promise<GitHubAuthStatus>
}
