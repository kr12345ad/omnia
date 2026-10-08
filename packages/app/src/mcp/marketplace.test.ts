import { describe, expect, test } from "bun:test"
import type { Config } from "@opencode-ai/sdk/v2/client"
import {
  CATEGORY_ALL,
  catalogIndex,
  categories,
  commandLabel,
  filterServers,
  formatPopularity,
  installedEntries,
  patchMcp,
  serverConfig,
  serverKey,
  uniqueServerKey,
  serverRuntime,
  type MarketplaceServer,
} from "./marketplace"

const server = (input: Partial<MarketplaceServer> & { command: string[] }): MarketplaceServer => ({
  id: input.id ?? input.command.join(" "),
  name: input.name ?? "Server",
  description: input.description ?? "",
  category: input.category ?? "other",
  ...input,
})

const github = server({
  id: "com.example/github",
  name: "GitHub",
  description: "Repos, issues and pull requests",
  category: "devtools",
  command: ["npx", "-y", "@modelcontextprotocol/server-github"],
  popularity: 42000,
})
const postgres = server({
  id: "com.example/postgres",
  name: "Postgres",
  description: "Query and inspect a Postgres database",
  category: "database",
  command: ["npx", "-y", "@modelcontextprotocol/server-postgres"],
})
const fetch = server({
  id: "docker/fetch",
  name: "Fetch",
  description: "Fetch a URL as markdown",
  category: "search",
  command: ["docker", "run", "-i", "--rm", "mcp/fetch"],
})

describe("marketplace catalog", () => {
  test("lists all first, then the categories present, sorted", () => {
    expect(categories([github, postgres, fetch])).toEqual([CATEGORY_ALL, "database", "devtools", "search"])
  })

  test("filters by category and by query and reports the unsliced total", () => {
    const all = [github, postgres, fetch]
    expect(filterServers(all, "", CATEGORY_ALL, 10)).toEqual({ servers: all, total: 3 })
    expect(filterServers(all, "", "database", 10).servers).toEqual([postgres])
    expect(filterServers(all, "postgres", CATEGORY_ALL, 10).servers).toEqual([postgres])
    expect(filterServers(all, "markdown", CATEGORY_ALL, 10).servers).toEqual([fetch])
    expect(filterServers(all, "issue", CATEGORY_ALL, 10).servers).toEqual([github])
    expect(filterServers(all, "", CATEGORY_ALL, 2)).toEqual({ servers: [github, postgres], total: 3 })
    expect(filterServers(all, "nothing here", CATEGORY_ALL, 10)).toEqual({ servers: [], total: 0 })
  })

  test("matches queries case insensitively", () => {
    expect(filterServers([github], "GITHUB", CATEGORY_ALL, 10).total).toBe(1)
  })

  test("paginates the complete result set and supports multi-word package search", () => {
    const all = Array.from({ length: 53 }, (_, index) =>
      server({
        id: `catalog/server-${index}`,
        name: `Server ${index}`,
        description: "GitHub repository tools",
        command: ["npx", "-y", `@acme/server-${index}`],
      }),
    )
    const second = filterServers(all, "github acme", CATEGORY_ALL, 24, { offset: 24 })
    expect(second.total).toBe(53)
    expect(second.servers).toEqual(all.slice(24, 48))
    expect(filterServers(all, "", CATEGORY_ALL, 24, { offset: 48 }).servers).toHaveLength(5)
  })

  test("sorts by popularity or name and filters runtimes", () => {
    const python = server({ name: "Alpha", command: ["uvx", "alpha"], popularity: 100 })
    expect(serverRuntime(python)).toBe("python")
    expect(serverRuntime(fetch)).toBe("docker")
    expect(filterServers([python, github, fetch], "", CATEGORY_ALL, 24, { runtime: "python" }).servers).toEqual([
      python,
    ])
    expect(filterServers([python, github], "", CATEGORY_ALL, 24, { sort: "popular" }).servers).toEqual([github, python])
    expect(filterServers([github, python], "", CATEGORY_ALL, 24, { sort: "name" }).servers).toEqual([python, github])
  })
})

describe("marketplace server keys", () => {
  test("derives a config key from the install command", () => {
    expect(serverKey(github)).toBe("modelcontextprotocol-server-github")
    expect(serverKey(fetch)).toBe("fetch")
    expect(serverKey(server({ command: ["uvx", "mcp-server-fetch"] }))).toBe("mcp-server-fetch")
    expect(serverKey(server({ command: ["npx", "-y", "@scope/Pkg.Name"] }))).toBe("scope-pkg-name")
  })

  test("avoids replacing an existing server", () => {
    expect(uniqueServerKey([], "fetch")).toBe("fetch")
    expect(uniqueServerKey(["fetch"], "fetch")).toBe("fetch-2")
    expect(uniqueServerKey(["fetch", "fetch-2"], "fetch")).toBe("fetch-3")
  })
})

describe("marketplace config writes", () => {
  test("writes a local server with only the settings the user filled in", () => {
    expect(serverConfig(fetch, {}, true)).toEqual({
      type: "local",
      command: ["docker", "run", "-i", "--rm", "mcp/fetch"],
      enabled: true,
    })
    expect(serverConfig(github, { GITHUB_TOKEN: "secret", EMPTY: "" }, false)).toEqual({
      type: "local",
      command: ["npx", "-y", "@modelcontextprotocol/server-github"],
      environment: { GITHUB_TOKEN: "secret" },
      enabled: false,
    })
  })

  test("patches one entry without touching the others", () => {
    const config: Config = { mcp: { github: { type: "local", command: ["npx", "-y", "github"] } } }
    const added = patchMcp(config, "fetch", { type: "local", command: ["docker", "run", "mcp/fetch"] })
    expect(Object.keys(added.mcp ?? {})).toEqual(["github", "fetch"])

    const disabled = patchMcp(added, "fetch", {
      type: "local",
      command: ["docker", "run", "mcp/fetch"],
      enabled: false,
    })
    expect(disabled.mcp?.fetch).toEqual({ type: "local", command: ["docker", "run", "mcp/fetch"], enabled: false })
    expect(disabled.mcp?.github).toEqual(config.mcp?.github)

    const removed = patchMcp(disabled, "github", undefined)
    expect(Object.keys(removed.mcp ?? {})).toEqual(["fetch"])
    expect(patchMcp(removed, "fetch", undefined).mcp).toEqual({})
    expect(patchMcp({ ...config, model: "newer/model" }, "fetch", serverConfig(fetch, {}, true))).not.toHaveProperty(
      "model",
    )
  })

  test("lists installed servers, resolving the catalog entry behind each one", () => {
    const config: Config = {
      mcp: {
        hand: { type: "remote", url: "https://example.com/mcp" },
        github: { type: "local", command: github.command, enabled: false },
      },
    }
    const installed = installedEntries(config, catalogIndex([github, fetch]))
    expect(installed.map((item) => item.name)).toEqual(["github", "hand"])
    expect(installed[0].catalog).toBe(github)
    expect(installed[1].catalog).toBeUndefined()
    expect(commandLabel(installed[1].entry)).toBe("https://example.com/mcp")
    expect(commandLabel({ enabled: false })).toBeUndefined()
  })
})

describe("marketplace formatting", () => {
  test("keeps counts short", () => {
    expect(formatPopularity(undefined)).toBeUndefined()
    expect(formatPopularity(0)).toBeUndefined()
    expect(formatPopularity(742)).toBe("742")
    expect(formatPopularity(42000)).toBe("42k")
    expect(formatPopularity(1_500_000)).toBe("1.5M")
  })
})
