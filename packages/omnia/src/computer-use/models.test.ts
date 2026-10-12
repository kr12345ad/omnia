import { describe, expect, test } from "bun:test"
import {
  createComputerUseCatalog,
  pinModel,
  pinRuntime,
  resolvePinnedModel,
  resolvePinnedRuntime,
  type ModelPin,
  type RuntimePin,
} from "./models"
import { createRuntimeCatalog } from "./runtimes"
import type { ComputerUseModel, ComputerUseRuntime } from "./types"

/**
 * A catalog identical to the shipped one except for the entry named here.
 *
 * The catalog is rebuilt from the environment between actions in production
 * (`createComputerUseCatalog({ env })`), which is exactly how a mid-session
 * swap reaches a session without anybody asking for one.
 */
function catalogWith(overrides: Partial<ComputerUseModel> & { readonly id: string }): ComputerUseModel[] {
  return createComputerUseCatalog().map((model) => (model.id === overrides.id ? { ...model, ...overrides } : model))
}

function catalogWithout(id: string): ComputerUseModel[] {
  return createComputerUseCatalog().filter((model) => model.id !== id)
}

const UI_TARS = "ui-tars-2b-q4_k_m"
const MOONDREAM = "moondream-2-q4_k"

describe("a catalog is self-describing about aim semantics", () => {
  test("every bundled model declares the coordinate space its output is denominated in", () => {
    // `pinModel` defaults an undeclared space to absolute, so a model that
    // forgot to declare one would silently ground in the wrong space.
    for (const model of createComputerUseCatalog()) {
      expect(`${model.id} -> ${String(model.coordinateSpace)}`).not.toBe(`${model.id} -> undefined`)
    }
  })

  test("the recommended grounding model and the describe fallback do not share a coordinate space", () => {
    // This is the pair a session could be swapped between: UI-TARS is the
    // default grounder and Moondream the describe/inspect fallback, and they
    // answer in different units. Anything that assumes otherwise lands clicks
    // a factor of 1000 away.
    const catalog = createComputerUseCatalog()
    const grounding = catalog.find((model) => model.id === UI_TARS)
    const fallback = catalog.find((model) => model.id === MOONDREAM)
    expect(grounding?.coordinateSpace).toBe("normalized-1000")
    expect(fallback?.coordinateSpace).toBe("normalized-1")
  })
})

describe("a pinned model", () => {
  test("resolves to itself while the catalog is unchanged", () => {
    const catalog = createComputerUseCatalog()
    const pinned = pinModel(catalog.find((model) => model.id === UI_TARS)!)
    const match = resolvePinnedModel(pinned, catalog)
    expect(match.status).toBe("resolved")
    expect(match.status === "resolved" && match.model.id).toBe(UI_TARS)
  })

  test("is refused when it is no longer in the catalog, instead of falling through to a neighbour", () => {
    // `selectModel` in providers.ts ends in `compatible[0]`, so an uninstall
    // between two actions of one session silently re-grounds the next action
    // with whatever happens to be first. The pin refuses instead.
    const catalog = createComputerUseCatalog()
    const pinned = pinModel(catalog.find((model) => model.id === UI_TARS)!)
    const match = resolvePinnedModel(pinned, catalogWithout(UI_TARS))
    expect(match.status).toBe("removed")
    expect(match.status === "removed" && match.reason).toContain(UI_TARS)
    expect(match.status === "removed" && match.reason).toContain("no longer in the catalog")
  })

  test("is refused when the same id is now served by a different provider", () => {
    // The hosted catalog derives its id from OMNIA_COMPUTER_USE_HOSTED_NAME, so
    // a rebuilt catalog can hand the same id to a different endpoint.
    const catalog = catalogWith({ id: UI_TARS, provider: "hosted:somebody-else" })
    const pinned: ModelPin = { modelId: UI_TARS, provider: "ui-tars", coordinateSpace: "normalized-1000" }
    const match = resolvePinnedModel(pinned, catalog)
    expect(match.status).toBe("removed")
    expect(match.status === "removed" && match.reason).toContain("hosted:somebody-else")
  })

  test("is refused when the same model now grounds in a different coordinate space", () => {
    // THE one that matters: the id, the provider and the confidence are all
    // unchanged, so nothing looks wrong. (500, 500) is a pixel off-centre in
    // absolute space and the exact centre of the screen in normalized-1000.
    const catalog = createComputerUseCatalog()
    const pinned = pinModel(catalog.find((model) => model.id === UI_TARS)!)
    const flipped = catalogWith({ id: UI_TARS, coordinateSpace: "absolute" })
    const match = resolvePinnedModel(pinned, flipped)
    expect(match.status).toBe("reinterpreted")
    expect(match.status === "reinterpreted" && match.reason).toContain("absolute")
    expect(match.status === "reinterpreted" && match.reason).toContain("normalized-1000")
    // ...and it is NOT resolved, so a caller cannot accidentally continue.
    expect(match.status === "resolved" && match.model.id).toBe(false)
  })

  test("moves only when the session pins the replacement explicitly", () => {
    // Re-pinning is allowed; inheriting it is not. A deliberate pin carries the
    // new aim semantics, so the next action is grounded in the space the new
    // model actually answers in.
    const catalog = catalogWith({ id: UI_TARS, coordinateSpace: "absolute" })
    const replacement = pinModel(catalog.find((model) => model.id === UI_TARS)!)
    expect(replacement.coordinateSpace).toBe("absolute")
    expect(resolvePinnedModel(replacement, catalog).status).toBe("resolved")
  })

  test("survives a catalog rebuilt from the same environment", () => {
    // The hosted catalog is rebuilt per call from env; a rebuild that produces
    // the same entries must not read as a swap.
    const first = createComputerUseCatalog()
    const pinned = pinModel(first.find((model) => model.id === UI_TARS)!)
    const second = createComputerUseCatalog()
    expect(resolvePinnedModel(pinned, second).status).toBe("resolved")
  })
})

describe("a pinned runtime", () => {
  const CPU = "linux-x64-cpu"

  function runtimes(): ComputerUseRuntime[] {
    const catalog = createRuntimeCatalog("linux-x64")
    expect(catalog.find((runtime) => runtime.id === CPU)).toBeDefined()
    return catalog
  }

  test("resolves to itself while the catalog is unchanged", () => {
    const catalog = runtimes()
    const pinned = pinRuntime(catalog.find((runtime) => runtime.id === CPU)!)
    expect(resolvePinnedRuntime(pinned, catalog).status).toBe("resolved")
  })

  test("is refused when it is no longer installed", () => {
    const catalog = runtimes()
    const pinned = pinRuntime(catalog.find((runtime) => runtime.id === CPU)!)
    const match = resolvePinnedRuntime(
      pinned,
      catalog.filter((runtime) => runtime.id !== CPU),
    )
    expect(match.status).toBe("removed")
  })

  test("is refused when the same id is now a different llama.cpp build", () => {
    // The sha256 pins are the authoritative identity of the bytes: a runtime
    // that resolves to the same id over different archives is a different
    // runtime, and a different build can decode the same weights differently.
    const catalog = runtimes()
    const pinned = pinRuntime(catalog.find((runtime) => runtime.id === CPU)!)
    const swapped: RuntimePin = { ...pinned, archives: ["0".repeat(64)] }
    const match = resolvePinnedRuntime(swapped, catalog)
    expect(match.status).toBe("reinterpreted")
    expect(match.status === "reinterpreted" && match.reason).toContain("archive pins")
  })

  test("is refused when the same id reports a different backend", () => {
    const catalog = runtimes()
    const pinned = pinRuntime(catalog.find((runtime) => runtime.id === CPU)!)
    const match = resolvePinnedRuntime({ ...pinned, backend: "cuda" }, catalog)
    expect(match.status).toBe("reinterpreted")
    expect(match.status === "reinterpreted" && match.reason).toContain("cuda")
  })
})
