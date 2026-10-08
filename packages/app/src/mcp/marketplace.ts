import type { Config } from "@opencode-ai/sdk/v2/client"

// One row of the generated catalog (script/generate-mcp-marketplace.ts). Every
// entry resolves to a runnable command, so the marketplace never shows a server
// it cannot actually install.
export type MarketplaceServer = {
  id: string
  name: string
  description: string
  category: string
  command: string[]
  env?: { name: string; description?: string; secret?: boolean; required?: boolean }[]
  popularity?: number
  homepage?: string
}

export type McpEntry = NonNullable<Config["mcp"]>[string]

export type InstalledServer = {
  name: string
  entry: McpEntry
  catalog: MarketplaceServer | undefined
}

export const CATEGORY_ALL = "all"

export type CatalogResults = {
  servers: MarketplaceServer[]
  total: number
}

export type MarketplaceRuntime = "all" | "node" | "python" | "docker" | "other"
export type MarketplaceSort = "popular" | "name"

export function serverRuntime(server: MarketplaceServer): Exclude<MarketplaceRuntime, "all"> {
  if (server.command[0] === "npx") return "node"
  if (server.command[0] === "uvx") return "python"
  if (server.command[0] === "docker") return "docker"
  return "other"
}

export function categories(servers: readonly MarketplaceServer[]) {
  return [CATEGORY_ALL, ...[...new Set(servers.map((server) => server.category))].sort()]
}

export function categoryLabel(category: string) {
  if (category === CATEGORY_ALL) return category
  return category.charAt(0).toUpperCase() + category.slice(1)
}

// Substring matching keeps filtering over the whole catalog under a frame; the
// catalog itself is already ordered by popularity, so matches keep that order.
export function filterServers(
  servers: readonly MarketplaceServer[],
  query: string,
  category: string,
  limit: number,
  options: { offset?: number; runtime?: MarketplaceRuntime; sort?: MarketplaceSort } = {},
): CatalogResults {
  const needles = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const matches = servers.filter(
    (server) =>
      (category === CATEGORY_ALL || server.category === category) &&
      (!options.runtime || options.runtime === "all" || serverRuntime(server) === options.runtime) &&
      needles.every((needle) =>
        `${server.name} ${server.description} ${server.id} ${commandKey(server.command)} ${server.category}`
          .toLowerCase()
          .includes(needle),
      ),
  )
  if (options.sort === "name") matches.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  if (options.sort === "popular") {
    matches.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0) || a.name.localeCompare(b.name))
  }
  const offset = Math.max(0, Math.floor(options.offset ?? 0))
  return { servers: matches.slice(offset, offset + Math.max(0, limit)), total: matches.length }
}

export function catalogIndex(servers: readonly MarketplaceServer[]) {
  return new Map(servers.map((server) => [commandKey(server.command), server]))
}

export function commandKey(command: readonly string[]) {
  return command.join(" ")
}

export function commandLabel(entry: McpEntry) {
  if ("command" in entry) return entry.command.join(" ")
  if ("url" in entry) return entry.url
  return undefined
}

export function installedEntries(config: Config, index: Map<string, MarketplaceServer>): InstalledServer[] {
  return Object.entries(config.mcp ?? {})
    .map(([name, entry]) => ({ name, entry, catalog: index.get(commandLabel(entry) ?? "") }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

// Config keys name the server in tool prefixes, so keep them short, lowercase and
// filesystem-safe: `@scope/pkg` becomes `scope-pkg` and `mcp/fetch` becomes `fetch`.
export function serverKey(server: MarketplaceServer) {
  const target = server.command.at(-1) ?? server.name
  const parts = target.split("/")
  return (server.command[0] === "docker" ? parts.slice(-1) : parts)
    .join("-")
    .replace(/^@/, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
}

export function uniqueServerKey(taken: readonly string[], key: string) {
  if (!taken.includes(key)) return key
  for (let index = 2; ; index++) {
    const candidate = `${key}-${index}`
    if (!taken.includes(candidate)) return candidate
  }
}

export function serverConfig(
  server: MarketplaceServer,
  environment: Record<string, string>,
  enabled: boolean,
): McpEntry {
  const values = Object.entries(environment).filter(([, value]) => value.length > 0)
  return {
    type: "local",
    command: [...server.command],
    ...(values.length > 0 ? { environment: Object.fromEntries(values) } : {}),
    enabled,
  }
}

// The server replaces the mcp map whenever a patch carries one, so writing the map
// back with an entry removed is what actually uninstalls a server.
export function patchMcp(config: Config, name: string, entry: McpEntry | undefined): Config {
  const mcp = { ...(config.mcp ?? {}) }
  if (entry === undefined) delete mcp[name]
  else mcp[name] = entry
  // Only send the edited map: an unrelated setting may have changed since the
  // page loaded, so posting the whole config can revert the user's newer work.
  return { mcp }
}

export function needsSettings(server: MarketplaceServer) {
  return (server.env?.length ?? 0) > 0
}

export function formatPopularity(value: number | undefined) {
  if (value === undefined || value <= 0) return undefined
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`
  if (value >= 1_000) return `${Math.round(value / 100) / 10}k`
  return String(value)
}

export * as McpMarketplace from "./marketplace"
