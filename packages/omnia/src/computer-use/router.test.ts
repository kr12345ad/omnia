import { describe, expect, test } from "bun:test"
import { LocalModelManager } from "./local"
import { MATCH_THRESHOLD, normalizeQuery, scoreMatch } from "./match-score"
import { SemanticProvider } from "./providers"
import { bestScore, DefaultComputerUseRouter, SEMANTIC_SUFFICIENT_THRESHOLD } from "./router"
import type { ComputerUseContext, ComputerUseSettings, HardwareReport, SemanticElement } from "./types"

function hardware(): HardwareReport {
  return {
    os: "linux",
    platform: "linux",
    arch: "x64",
    cpuCores: 8,
    memoryTotalBytes: 32 * 1024 ** 3,
    memoryFreeBytes: 24 * 1024 ** 3,
    unifiedMemory: false,
    gpus: [],
    diskFreeBytes: 100 * 1024 ** 3,
    backends: ["cpu"],
  }
}

function settings(overrides: Partial<ComputerUseSettings> = {}): ComputerUseSettings {
  return {
    mode: "automatic",
    allowDownloads: false,
    allowAutoLoad: true,
    allowRemoteScreen: false,
    maxLatencyMs: 120000,
    maxRetries: 1,
    idleUnloadMs: 0,
    ...overrides,
  }
}

function context(overrides: Partial<ComputerUseContext> = {}): ComputerUseContext {
  return {
    computerId: "local",
    requestedOperation: "click",
    platform: "linux",
    ...overrides,
  }
}

function localManager(dir: string): LocalModelManager {
  return new LocalModelManager({
    catalog: [],
    modelsDir: dir,
    runtimeDirs: [],
    hardware: hardware(),
    idleUnloadMs: 0,
  })
}

function environment(elements: readonly SemanticElement[], coverage: number) {
  return { coverage, elements }
}

describe("match-score shared threshold", () => {
  test("MATCH_THRESHOLD is 0.6 and the router threshold references it", () => {
    expect(MATCH_THRESHOLD).toBe(0.6)
    expect(SEMANTIC_SUFFICIENT_THRESHOLD).toBe(MATCH_THRESHOLD)
  })

  test("normalizeQuery trims and lowercases", () => {
    expect(normalizeQuery("  Export  ")).toBe("export")
    expect(normalizeQuery("OC | Quick Hello")).toBe("oc | quick hello")
    expect(normalizeQuery("   ")).toBe("")
  })

  test("scoreMatch returns 0 below the threshold", () => {
    expect(scoreMatch("export", { name: "Terminal", role: "window" })).toBe(0)
    expect(scoreMatch("minimize", { name: "OK", role: "button" })).toBe(0)
    expect(scoreMatch("", { name: "Export" })).toBe(0)
  })

  test("scoreMatch rewards a name that contains the whole query, exact adds 0.25", () => {
    expect(scoreMatch("export", { name: "Export", role: "button" })).toBe(0.85)
    expect(scoreMatch("save", { name: "Save as", role: "button" })).toBe(0.6)
    expect(scoreMatch("oc | quick hello", { name: "OC | Quick hello", role: "window" })).toBe(0.85)
    expect(scoreMatch("window", { name: "Terminal", role: "window" })).toBe(0)
  })
})

describe("bestScore agrees with the shared scorer", () => {
  test("returns undefined below the shared threshold", () => {
    const kittyQuery = "the kitty terminal window titled oc | quick hello / focus the kitty terminal"
    // The removed query.includes(name) 0.4 over-match: the query once swallowed
    // the short name "terminal" and routed to a screen-center click.
    expect(bestScore([{ name: "Terminal", role: "window" }], kittyQuery)).toBeUndefined()
    // A role-only hit never reaches the threshold either.
    expect(bestScore([{ name: "Terminal", role: "window" }], "window")).toBeUndefined()
    expect(bestScore([], "export")).toBeUndefined()
  })

  test("an exact element ref is definitive at 1", () => {
    expect(bestScore([{ elementId: "atspi:3.5", name: "Something else" }], "atspi:3.5")).toBe(1)
  })

  test("every element scores identically in bestScore and scoreMatch", () => {
    const elements: SemanticElement[] = [
      { role: "button", name: "Export", bounds: { x: 0, y: 0, width: 10, height: 10 }, source: "accessibility" },
      { role: "window", name: "Terminal", bounds: { x: 0, y: 0, width: 10, height: 10 }, source: "accessibility" },
      { role: "textfield", text: "Command", source: "accessibility" },
      { role: "button", name: "Minimize", source: "accessibility" },
    ]
    for (const query of ["export", "window", "the kitty terminal window titled oc | quick hello", "command", "minimize"]) {
      const routed = bestScore(elements, query)
      const scores = elements.map((element) => scoreMatch(query, element))
      const expected = scores.reduce((best, score) => (score > 0 && (best === undefined || score > best) ? score : best), undefined as number | undefined)
      expect(routed).toBe(expected)
    }
  })
})

describe("semanticSufficient alignment", () => {
  test("a match at the shared threshold routes semantically; below it the router refuses", async () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/omnia-router-test-${crypto.randomUUID()}`
    const router = new DefaultComputerUseRouter({
      providers: [new SemanticProvider()],
      local: localManager(dir),
      settings: () => settings(),
    })
    const atThreshold = await router.route(
      context({
        requestedOperation: "click",
        targetDescription: "export",
        semanticContext: environment([{ role: "button", name: "Export", source: "accessibility" }], 0.9),
      }),
    )
    expect(atThreshold.provider).toBe("semantic")

    const overMatch = await router.route(
      context({
        requestedOperation: "click",
        targetDescription: "expedited export",
        semanticContext: environment([{ role: "button", name: "Export", source: "accessibility" }], 0.9),
      }),
    )
    // "expedited export" does not contain the candidate name "Export" as a
    // whole substring, so bestScore is undefined: the router refuses to claim
    // semantic sufficiency (the 0.5-vs-0.4 mismatch is gone by construction).
    expect(overMatch.provider).toBe("none")
  })
})
