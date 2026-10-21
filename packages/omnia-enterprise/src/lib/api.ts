import type {
  AuditEvent,
  ClientRelease,
  Distribution,
  Group,
  Integrations,
  Invite,
  LicenseStatus,
  Organization,
  ReleaseOverview,
  Policies,
  PublicConfig,
  Role,
  SessionPayload,
  Summary,
  UsageInsights,
  UsageResponse,
  User,
  UserStatus,
} from "@/types"

const BASE = "/v1/enterprise"

export class ApiError extends Error {
  readonly status: number
  readonly code?: string

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    credentials: "include",
    cache: "no-store",
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.headers ?? {}),
    },
  }).catch((error: unknown) => {
    throw new ApiError(
      error instanceof Error && error.message.includes("fetch")
        ? "The server is unreachable. Check that omnia-server is running."
        : "The request could not be sent.",
      0,
    )
  })
  const type = response.headers.get("content-type") ?? ""
  const payload = type.includes("application/json")
    ? ((await response.json().catch(() => ({}))) as Record<string, unknown>)
    : {}
  if (!response.ok) {
    throw new ApiError(
      typeof payload.error === "string" ? payload.error : `Request failed (${response.status}).`,
      response.status,
      typeof payload.code === "string" ? payload.code : undefined,
    )
  }
  return payload as T
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text.length === 0 ? "" : `?${text}`
}

export const api = {
  publicConfig: () => request<PublicConfig>("/public/config"),
  setup: (input: { token: string; email: string; name: string; password: string }) =>
    request<SessionPayload>("/public/setup", { method: "POST", body: JSON.stringify(input) }),
  login: (input: { email: string; password: string }) =>
    request<SessionPayload>("/public/login", { method: "POST", body: JSON.stringify(input) }),
  acceptInvite: (input: { token: string; password: string; name?: string }) =>
    request<SessionPayload>("/public/invite", { method: "POST", body: JSON.stringify(input) }),

  session: () => request<SessionPayload>("/session"),
  logout: () => request<{ ok: true }>("/logout", { method: "POST" }),
  changePassword: (input: { currentPassword: string; newPassword: string }) =>
    request<{ ok: true }>("/password", { method: "POST", body: JSON.stringify(input) }),

  summary: (days = 30) => request<{ ok: true; summary: Summary }>(`/summary${query({ days })}`),
  organization: () => request<{ ok: true; organization: Organization }>("/org"),
  assets: () => request<{ ok: true; assets: { name: string; url: string; bytes: number; createdAt: number }[] }>("/assets"),
  uploadAsset: (input: { kind: "logo" | "icon"; contentType: string; data: string }) =>
    request<{ ok: true; url: string }>("/assets", { method: "POST", body: JSON.stringify(input) }),
  deleteAsset: (name: string) =>
    request<{ ok: true }>(`/assets/${encodeURIComponent(name)}`, { method: "DELETE" }),
  updateOrganization: (patch: Partial<Organization>) =>
    request<{ ok: true; organization: Organization }>("/org", { method: "PATCH", body: JSON.stringify(patch) }),

  policies: () => request<{ ok: true; policies: Policies }>("/policies"),
  savePolicies: (policies: Policies) =>
    request<{ ok: true; policies: Policies }>("/policies", { method: "PUT", body: JSON.stringify(policies) }),

  users: (params: { query?: string; status?: string; role?: string; limit?: number; offset?: number } = {}) =>
    request<{ ok: true; users: User[]; total: number }>(`/users${query(params)}`),
  invite: (input: { email: string; name?: string; role: Role; groupIds?: string[] }) =>
    request<{ ok: true; invite: Invite; token: string; url: string }>("/users/invite", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  createUser: (input: {
    email: string
    name: string
    role: Role
    password?: string
    employeeId?: string
    title?: string
    department?: string
    groupIds?: string[]
  }) => request<{ ok: true; user: User }>("/users", { method: "POST", body: JSON.stringify(input) }),
  updateUser: (
    id: string,
    patch: Partial<Pick<User, "name" | "role" | "groupIds" | "employeeId" | "title" | "department" | "mfaEnabled">> & {
      status?: UserStatus
    },
  ) => request<{ ok: true; user: User }>(`/users/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteUser: (id: string) => request<{ ok: true }>(`/users/${encodeURIComponent(id)}`, { method: "DELETE" }),
  resetUser: (id: string) =>
    request<{ ok: true; token: string; url: string }>(`/users/${encodeURIComponent(id)}/reset`, { method: "POST" }),
  invites: () => request<{ ok: true; invites: Invite[] }>("/invites"),
  revokeInvite: (id: string) => request<{ ok: true }>(`/invites/${encodeURIComponent(id)}`, { method: "DELETE" }),

  groups: () => request<{ ok: true; groups: Group[] }>("/groups"),
  createGroup: (input: Partial<Group> & { name: string }) =>
    request<{ ok: true; group: Group }>("/groups", { method: "POST", body: JSON.stringify(input) }),
  updateGroup: (id: string, patch: Partial<Group>) =>
    request<{ ok: true; group: Group }>(`/groups/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteGroup: (id: string) => request<{ ok: true }>(`/groups/${encodeURIComponent(id)}`, { method: "DELETE" }),

  distributions: () => request<{ ok: true; distributions: Distribution[] }>("/distributions"),
  distribution: (id: string) =>
    request<{ ok: true; distribution: Distribution; manifest: unknown }>(`/distributions/${encodeURIComponent(id)}`),
  createDistribution: (input: { name: string; slug?: string; description?: string }) =>
    request<{ ok: true; distribution: Distribution }>("/distributions", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateDistribution: (id: string, patch: Partial<Distribution>) =>
    request<{ ok: true; distribution: Distribution }>(`/distributions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  publishDistribution: (id: string, input: { version: string; releaseNotes?: string }) =>
    request<{ ok: true; distribution: Distribution }>(`/distributions/${encodeURIComponent(id)}/publish`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  duplicateDistribution: (id: string) =>
    request<{ ok: true; distribution: Distribution }>(`/distributions/${encodeURIComponent(id)}/duplicate`, {
      method: "POST",
    }),
  deleteDistribution: (id: string) =>
    request<{ ok: true }>(`/distributions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  releases: (id: string) =>
    request<ReleaseOverview>(`/distributions/${encodeURIComponent(id)}/releases`),
  buildDistribution: (id: string, platforms: string[]) =>
    request<{ ok: true; releases: ClientRelease[]; errors: string[] }>(
      `/distributions/${encodeURIComponent(id)}/releases`,
      { method: "POST", body: JSON.stringify({ platforms }) },
    ),
  release: (id: string, releaseId: string) =>
    request<{ ok: true; release: ClientRelease; artifact?: string }>(
      `/distributions/${encodeURIComponent(id)}/releases/${encodeURIComponent(releaseId)}`,
    ),

  usage: (params: { days?: number; groupBy?: string; userId?: string; model?: string } = {}) =>
    request<UsageResponse>(`/usage${query(params)}`),
  usageInsights: (days = 30) => request<UsageInsights>(`/usage/insights${query({ days })}`),
  audit: (params: { limit?: number; before?: number; action?: string } = {}) =>
    request<{ ok: true; events: AuditEvent[]; total: number }>(`/audit${query(params)}`),
  license: () => request<LicenseStatus>("/license"),
  activateLicense: (token: string) =>
    request<{ ok: boolean; error?: string; license: LicenseStatus["license"] }>("/license", {
      method: "PUT",
      body: JSON.stringify({ token }),
    }),
  integrations: () => request<{ ok: true; integrations: Integrations }>("/integrations"),
  saveIntegrations: (integrations: Integrations) =>
    request<{ ok: true; integrations: Integrations }>("/integrations", {
      method: "PUT",
      body: JSON.stringify(integrations),
    }),
  rotateScimToken: () => request<{ ok: true; token: string; baseUrl: string }>("/scim/token", { method: "POST" }),
}

export function download(path: string): void {
  window.location.assign(`${BASE}${path}`)
}

export function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401
}
