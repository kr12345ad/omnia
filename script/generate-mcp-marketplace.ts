#!/usr/bin/env bun
// Regenerates the MCP marketplace catalog bundled with the app.
//
// Sources are limited to openly readable, redistributable index metadata:
//   - the official MCP registry, which is the only source that publishes
//     runnable package descriptors (registryType/identifier/environmentVariables)
//   - the Docker MCP catalog for containerized servers
//   - npm weekly download counts, joined on the exact package name
//
// Only servers that resolve to a runnable command are catalogued. Directory
// entries that describe a remote endpoint without a package cannot be installed
// by this marketplace, so they are dropped rather than shown as dead rows.
//
// Nothing here is fetched at runtime: the catalog is a checked-in JSON file so
// the marketplace renders instantly and works offline. Re-run with
// `bun run generate:mcp-marketplace`.

const REGISTRY = "https://registry.modelcontextprotocol.io/v0/servers"
const OUT = new URL("../packages/app/src/mcp/marketplace.json", import.meta.url).pathname
const MAX_REGISTRY_PAGES = 400
const MAX_DESCRIPTION = 160
const MAX_ENV_DESCRIPTION = 100
const NPM_BATCH = 128
const NPM_POOL = 3
const DOCKER_POOL = 6
const NPM_PACE_MS = 900
const NPM_RETRIES = 3
const NPM_RETRY_MS = 2_000
const NPM_TIMEOUT_MS = 20_000

type Entry = {
  id: string
  name: string
  description: string
  category: string
  command: string[]
  env?: { name: string; description?: string; secret?: boolean; required?: boolean }[]
  popularity?: number
  homepage?: string
}

type RegistryPackage = {
  registryType: string
  identifier: string
  environmentVariables?: { name: string; description?: string; isSecret?: boolean; isRequired?: boolean }[]
}

type RegistryServer = {
  name: string
  title?: string
  description: string
  version: string
  websiteUrl?: string
  repository?: { url?: string }
  packages?: RegistryPackage[]
}

type RegistryResponse = {
  servers: { server: RegistryServer; _meta?: Record<string, { status?: string }> }[]
  metadata?: { nextCursor?: string }
}

// First match wins, so the more specific domains come first.
const CATEGORIES: [string, RegExp][] = [
  ["browser", /browser|playwright|puppeteer|chrome|cdp|selenium|scrape|scraping|automation/],
  [
    "database",
    /\bsql\b|postgres|mysql|mongo|sqlite|redis|database|\bdb\b|clickhouse|snowflake|bigquery|duckdb|trino|neo4j|supabase/,
  ],
  ["search", /search|exa\b|tavily|brave|serp|perplexity|arxiv|scholar|knowledge|lookup/],
  [
    "devtools",
    /github|gitlab|\bgit\b|jira|linear|sentry|docker|kubernetes|\bk8s\b|terraform|cloudflare|\baws\b|azure|\bgcp\b|vercel|netlify|deploy|\bci\b|npm|vscode|\bide\b|lint|openapi|graphql|swagger|\bcli\b|compiler|\bcode\b|testing|\bunit test\b/,
  ],
  [
    "productivity",
    /notion|obsidian|todoist|calendar|gmail|outlook|slack|discord|telegram|email|notes|task|todo|drive|sheets|excel|office|word|docs|document|pdf|ats|resume|project/,
  ],
  ["ai", /\bllm\b|openai|anthropic|embedding|vector|\brag\b|model|inference|memory|agent|prompt|gemini|ollama|hugging/],
  ["media", /image|video|audio|music|spotify|figma|design|canva|youtube|photo|3d\b|blender|render|font|gif/],
  ["finance", /finance|stripe|payment|invoice|crypto|bitcoin|trading|stock|wallet|accounting|bank|ledger|payroll/],
  ["data", /analytic|dataset|\bcsv\b|\betl\b|warehouse|chart|visuali|metric|monitor|observab|log\b|grafana|dashboard/],
  ["communication", /chat|message|\bsms\b|whatsapp|zoom|meet|mail|inbox|support|helpdesk|crm|salesforce/],
]

const runners: Record<string, (identifier: string) => string[] | undefined> = {
  npm: (identifier) => ["npx", "-y", identifier],
  pypi: (identifier) => ["uvx", identifier],
  oci: (identifier) => ["docker", "run", "-i", "--rm", identifier],
}

const log = (message: string) => console.log(message)

// Every request is bounded and retried: a single hung socket used to stall the
// whole run, and a long crawl always loses a few connections along the way.
async function json<T>(url: string, timeout = 20_000): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeout),
      })
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      return (await response.json()) as T
    } catch (error) {
      if (attempt === 3) throw new Error(`${url}: ${error instanceof Error ? error.message : String(error)}`)
      await Bun.sleep(1_000 * attempt)
    }
  }
}

async function registry(): Promise<Entry[]> {
  const entries: Entry[] = []
  let cursor: string | undefined

  for (let page = 0; page < MAX_REGISTRY_PAGES; page++) {
    const query = new URLSearchParams({ limit: "100", version: "latest" })
    if (cursor) query.set("cursor", cursor)
    const body = await json<RegistryResponse>(`${REGISTRY}?${query}`)

    for (const item of body.servers) {
      const server = item.server
      if (item._meta?.["io.modelcontextprotocol.registry/official"]?.status === "deprecated") continue
      const entry = fromRegistry(server)
      if (entry) entries.push(entry)
    }

    cursor = body.metadata?.nextCursor
    if (!cursor) break
    if (page % 20 === 0) log(`  registry page ${page + 1}: ${entries.length} entries`)
  }

  return entries
}

function fromRegistry(server: RegistryServer): Entry | undefined {
  const pkg = [...(server.packages ?? [])]
    .filter((item) => runners[item.registryType] !== undefined && !item.identifier.includes("{"))
    .sort((a, b) => priority(a.registryType) - priority(b.registryType))[0]
  const command = pkg ? runners[pkg.registryType](pkg.identifier) : undefined
  if (!command) return undefined

  const env = pkg!.environmentVariables
    ?.filter((variable) => variable.name.length > 0)
    .map((variable) => ({
      name: variable.name,
      description: trim(variable.description, MAX_ENV_DESCRIPTION),
      secret: variable.isSecret,
      required: variable.isRequired,
    }))

  return {
    id: server.name,
    name: server.title?.trim() || server.name.split("/").at(-1) || server.name,
    description: trim(server.description, MAX_DESCRIPTION) ?? "",
    category: category(`${server.name} ${server.title ?? ""} ${server.description}`),
    command,
    ...(env && env.length > 0 ? { env } : {}),
    ...(server.websiteUrl || server.repository?.url ? { homepage: server.websiteUrl ?? server.repository?.url } : {}),
  }
}

function priority(registryType: string) {
  return ["npm", "pypi", "oci"].indexOf(registryType)
}

// Docker Hub's repository listing starts answering 403 past the first page, so
// the containerized servers come from the catalog repository's own definitions.
type DockerServer = {
  name: string
  image: string
  meta?: { category?: string; tags?: string[] }
  about?: { title?: string; description?: string; icon?: string }
  source?: { project?: string }
}

async function docker(): Promise<Entry[]> {
  const tree = await json<{ tree: { path: string }[] }>(
    "https://api.github.com/repos/docker/mcp-registry/git/trees/main?recursive=1",
  )
  const definitions = tree.tree
    .map((item) => item.path)
    .filter((item) => item.startsWith("servers/") && item.endsWith("/server.yaml"))
  log(`  docker: ${definitions.length} definitions`)

  const entries: Entry[] = []
  for (let index = 0; index < definitions.length; index += DOCKER_POOL) {
    const batch = definitions.slice(index, index + DOCKER_POOL)
    const parsed = await Promise.all(
      batch.map(async (path) => {
        const response = await fetch(`https://raw.githubusercontent.com/docker/mcp-registry/main/${path}`, {
          signal: AbortSignal.timeout(20_000),
        })
        if (!response.ok) throw new Error(`${response.status} for ${path}`)
        return Bun.YAML.parse(await response.text()) as DockerServer
      }),
    )

    for (const server of parsed) {
      if (!server.image || server.image.includes("{")) continue
      entries.push({
        id: `docker/${server.image}`,
        name: server.about?.title?.trim() || title(server.image.split("/").at(-1)!),
        description: trim(server.about?.description, MAX_DESCRIPTION) ?? "",
        category: category(
          `${server.name} ${server.image} ${server.meta?.category ?? ""} ${(server.meta?.tags ?? []).join(" ")} ${server.about?.description ?? ""}`,
        ),
        command: ["docker", "run", "-i", "--rm", server.image],
        ...(server.source?.project ? { homepage: server.source.project } : {}),
      })
    }
  }

  return entries
}

function title(value: string) {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (character) => character.toUpperCase())
}

// Catalogs written before only runnable servers were kept carried an `install`
// object. Read either shape so an older snapshot stays re-filterable.
type SnapshotEntry = Omit<Entry, "command"> & {
  command?: string[]
  install?: { type: string; command?: string[] }
}

function installable(entry: SnapshotEntry): Entry | undefined {
  const command = entry.command ?? (entry.install?.type === "local" ? entry.install.command : undefined)
  if (!command) return undefined
  const { install: _install, ...rest } = entry
  // Re-derive the category too: re-filtering applies today's rules, not the ones
  // the snapshot was written with.
  return { ...rest, command, category: category(`${rest.id} ${rest.name} ${rest.description}`) }
}

// npm throttles download lookups to about three requests per second, so the pass
// is paced rather than parallel: unscoped names go 128 at a time through the
// bulk endpoint, and scoped names (which bulk rejects) are walked by a small
// pool at roughly the allowed rate, which takes about half an hour for the whole
// catalog. A name with no data keeps its previous value rather than being
// recorded as zero downloads.
async function withPopularity(entries: Entry[]): Promise<Entry[]> {
  const packages = [
    ...new Set(entries.filter((entry) => entry.command[0] === "npx").map((entry) => entry.command.at(-1)!)),
  ]
  const scoped = packages.filter((name) => name.startsWith("@"))
  const unscoped = packages.filter((name) => !name.startsWith("@"))
  log(`  npm: ${packages.length} packages (${unscoped.length} bulked, ${scoped.length} paced)`)
  const downloads = new Map<string, number>()

  for (let index = 0; index < unscoped.length; index += NPM_BATCH) {
    if (index > 0 && index % (NPM_BATCH * 20) === 0) log(`  npm: bulk ${index}/${unscoped.length}`)
    const counts = await downloadsFor(unscoped.slice(index, index + NPM_BATCH).join(","))
    for (const [name, value] of Object.entries(counts ?? {})) {
      const count = countOf(value)
      if (count !== undefined) downloads.set(name, count)
    }
    await Bun.sleep(NPM_PACE_MS)
  }

  let next = 0
  await Promise.all(
    Array.from({ length: NPM_POOL }, async () => {
      while (next < scoped.length) {
        const name = scoped[next++]
        const count = countOf(await downloadsFor(name))
        if (count !== undefined) downloads.set(name, count)
        if (next % 500 === 0) log(`  npm: paced ${next}/${scoped.length}`)
        await Bun.sleep(NPM_PACE_MS)
      }
    }),
  )

  return entries.map((entry) =>
    entry.command[0] === "npx"
      ? { ...entry, popularity: downloads.get(entry.command.at(-1)!) ?? entry.popularity }
      : entry,
  )
}

// The bulk endpoint answers with a map of name to counts (null for unknown
// packages) and the single endpoint with one record, so both shapes are read.
// A throttled or failed request is retried with backoff and then gives up, which
// leaves those packages unranked instead of claiming they have no downloads.
async function downloadsFor(query: string): Promise<Record<string, unknown> | undefined> {
  for (let attempt = 0; attempt < NPM_RETRIES; attempt++) {
    const body = await fetch(`https://api.npmjs.org/downloads/point/last-week/${query}`, {
      signal: AbortSignal.timeout(NPM_TIMEOUT_MS),
    }).catch(() => undefined)
    if (body?.ok) return (await body.json()) as Record<string, unknown>
    if (body?.status !== 429) return undefined
    await Bun.sleep(NPM_RETRY_MS)
  }
  return undefined
}

function countOf(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const downloads = (value as { downloads?: unknown }).downloads
  return typeof downloads === "number" ? downloads : undefined
}

// Registries mirror each other, so the same command can arrive many times. Keep
// the most descriptive record and the highest popularity seen for it.
function dedupe(entries: Entry[]) {
  const best = new Map<string, Entry>()
  for (const entry of entries) {
    const key = entry.command.join(" ")
    const current = best.get(key)
    if (!current) {
      best.set(key, entry)
      continue
    }
    const preferred = (entry.env?.length ?? 0) > (current.env?.length ?? 0) ? entry : current
    best.set(key, { ...preferred, popularity: Math.max(entry.popularity ?? 0, current.popularity ?? 0) || undefined })
  }
  return [...best.values()]
}

function category(value: string) {
  const haystack = value.toLowerCase()
  for (const [name, pattern] of CATEGORIES) {
    if (pattern.test(haystack)) return name
  }
  return "other"
}

function trim(value: string | undefined, max: number) {
  if (value === undefined) return undefined
  const text = value.replace(/\s+/g, " ").trim()
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const boundary = cut.lastIndexOf(" ")
  return `${boundary > max / 2 ? cut.slice(0, boundary) : cut}…`
}

function serialize(servers: Entry[]) {
  const lines = servers.map((server) => `  ${JSON.stringify(server)}`)
  return `{\n  "version": 1,\n  "generated": "${new Date().toISOString().slice(0, 10)}",\n  "servers": [\n${lines.join(",\n")}\n  ]\n}\n`
}

// Registry cursor pages take about ten seconds each, so a full crawl runs for
// close to an hour. `--from=<catalog.json>` re-applies the current rules to an
// existing snapshot instead, which is how field and selection changes ship
// without crawling again.
const snapshot = process.argv.find((flag) => flag.startsWith("--from="))?.slice("--from=".length)

log(snapshot ? `Re-filtering ${snapshot}…` : "Fetching the official MCP registry…")
const collected = await withPopularity(
  snapshot
    ? ((await Bun.file(snapshot).json()) as { servers: SnapshotEntry[] }).servers.flatMap((entry) => {
        const filtered = installable(entry)
        return filtered ? [filtered] : []
      })
    : dedupe([...(await registry()), ...(await docker())]),
)

const ranked = [...collected]
ranked.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0) || a.name.localeCompare(b.name))

await Bun.write(OUT, serialize(ranked))

const bytes = (await Bun.file(OUT).size) / 1024
const counts = ranked.reduce<Record<string, number>>((total, entry) => {
  total[entry.category] = (total[entry.category] ?? 0) + 1
  return total
}, {})
log(`Wrote ${ranked.length} servers (${bytes.toFixed(0)} KiB) to ${OUT}`)
log(`  with settings: ${ranked.filter((entry) => entry.env?.length).length}`)
log(
  `  runners: ${["npx", "uvx", "docker"]
    .map((runner) => `${runner}=${ranked.filter((entry) => entry.command[0] === runner).length}`)
    .join(" ")}`,
)
log(`  ranked by npm downloads: ${ranked.filter((entry) => (entry.popularity ?? 0) > 0).length}`)
log(
  `  categories: ${Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}=${count}`)
    .join(" ")}`,
)
