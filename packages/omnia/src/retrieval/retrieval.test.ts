import { describe, expect, test } from "bun:test"
import type { Observation, UIElement } from "../protocol"
import {
  disambiguateCandidates,
  retrieveElements,
  revalidateTarget,
} from "./index"

const observation: Observation = {
  id: "observation-1",
  source: "accessibility",
  backend: "native",
  provenance: { source: "accessibility", trust: "untrusted" },
  elements: [
    { id: "window-1", role: "window", name: "Editor", states: ["focused"] },
    {
      id: "save",
      parentId: "window-1",
      role: "button",
      name: "Save changes",
      description: "Write the current document",
      reference: {
        kind: "element",
        elementId: "save",
        observationId: "observation-1",
        generation: 4,
        source: "accessibility",
        backend: "native",
      },
      provenance: { source: "accessibility", trust: "untrusted" },
    },
    { id: "cancel", parentId: "window-1", role: "button", name: "Cancel" },
    { id: "status", parentId: "window-1", role: "status", value: "ready" },
  ],
}

describe("semantic retrieval", () => {
  test("matches exact and fuzzy names while preserving deterministic order", () => {
    const exact = retrieveElements(observation, { query: "Save changes", role: "button", exact: true })
    const fuzzy = retrieveElements(observation, { query: "sve changes", role: "button" })

    expect(exact.matches.map((match) => match.element.id)).toEqual(["save"])
    expect(exact.matches[0]?.confidence).toBeGreaterThan(0.8)
    expect(fuzzy.matches[0]?.element.id).toBe("save")
    expect(fuzzy.hierarchy.activeWindowId).toBe("window-1")
    expect(fuzzy.matches[0]?.provenance.source).toBe("accessibility")
  })

  test("applies role, description, and value filters", () => {
    const result = retrieveElements(observation, {
      query: "",
      role: "status",
      description: "current document",
      value: "ready",
    })

    expect(result.matches).toHaveLength(0)
    expect(retrieveElements(observation, { query: "", value: "ready" }).matches[0]?.element.id).toBe("status")
    expect(retrieveElements(observation, { query: "", role: "AXPushButton" }).matches.map((match) => match.element.id)).toContain("save")
  })

  test("keeps hierarchy paths and active context visible", () => {
    const result = retrieveElements(observation, { query: "save", context: { activeWindowId: "window-1" } })
    const match = result.matches[0]

    expect(match?.hierarchyPath).toEqual(["window-1", "save"])
    expect(match?.depth).toBe(1)
    expect(match?.contextScore).toBeGreaterThan(0)
    expect(result.metadata.activeWindowId).toBe("window-1")
  })
})

describe("candidate disambiguation and revalidation", () => {
  test("does not silently choose equally confident candidates", () => {
    const result = retrieveElements(observation, { query: "button" })
    const decision = disambiguateCandidates(result)

    expect(decision.status).toBe("ambiguous")
    expect(decision.needsDisambiguation).toBe(true)
    expect(decision.candidates.map((candidate) => candidate.element.id)).toEqual(["cancel", "save"])
  })

  test("rejects a target when its observation generation changed", () => {
    const target = {
      kind: "element" as const,
      elementId: "save",
      reference: {
        kind: "element" as const,
        elementId: "save",
        observationId: "observation-1",
        generation: 3,
      },
    }
    const result = revalidateTarget(target, observation)

    expect(result.valid).toBe(false)
    expect(result.status).toBe("stale")
    expect(result.reason).toContain("generation")
  })

  test("accepts a target whose identity and generation are unchanged", () => {
    const element = observation.elements?.find((value): value is UIElement => value.id === "save")
    if (element?.reference === undefined) throw new Error("fixture reference missing")
    const result = revalidateTarget({ kind: "element", elementId: "save", reference: element.reference }, observation)

    expect(result.valid).toBe(true)
    expect(result.status).toBe("valid")
    expect(result.reference?.generation).toBe(4)
  })
})
describe("retrieval input hardening", () => {
  test("invalid thresholds and limits are clamped instead of throwing", () => {
    expect(() => retrieveElements(observation, { query: "save", fuzzyThreshold: 2 })).not.toThrow()
    expect(() => retrieveElements(observation, { query: "save", fuzzyThreshold: Number.NaN })).not.toThrow()
    expect(() => retrieveElements(observation, { query: "save", limit: -3 })).not.toThrow()
    expect(retrieveElements(observation, { query: "save", limit: -3 }).matches.length).toBe(0)
  })

  test("NaN candidate confidence is coerced from the score", () => {
    const candidate = {
      element: { id: "save" },
      score: 0.7,
      confidence: Number.NaN,
      provenance: { source: "accessibility", trust: "untrusted" },
      matchedOn: [],
      hierarchyPath: ["save"],
      depth: 0,
      contextScore: 0,
      elementIndex: 0,
    }
    const decision = disambiguateCandidates([candidate])
    expect(decision.status).toBe("resolved")
    expect(decision.selected?.confidence).toBe(0.7)
  })

  test("mutating actions require a higher confidence floor", () => {
    const candidate = {
      element: { id: "save" },
      score: 0.55,
      confidence: 0.55,
      provenance: { source: "accessibility", trust: "untrusted" },
      matchedOn: [],
      hierarchyPath: ["save"],
      depth: 0,
      contextScore: 0,
      elementIndex: 0,
    }
    expect(disambiguateCandidates([candidate]).status).toBe("resolved")
    expect(disambiguateCandidates([candidate], { mutating: true }).status).toBe("not-found")
  })
})
