import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { HttpServerResponse } from "effect/unstable/http"
import { serveEmbeddedUIEffect } from "../../src/server/shared/ui"
import { testEffect } from "../lib/effect"

// Acceptance contract for the mobile surface: the embedded UI must serve
// mobile.html at /mobile (and /mobile/ and /mobile.html) and must never let an
// unknown path silently fall through to the full workspace document when the
// mobile document is what was asked for.
const it = testEffect(AppNodeBuilder.build(FSUtil.node))

const embedded = {
  "index.html": "/$bunfs/root/index.html",
  "mobile.html": "/$bunfs/root/mobile.html",
}

const readFile = (path: string) => {
  if (path === "/$bunfs/root/mobile.html")
    return Effect.succeed(new TextEncoder().encode("<html><head><title>Omnia Mobile</title></head></html>"))
  if (path === "/$bunfs/root/index.html")
    return Effect.succeed(new TextEncoder().encode("<html><head><title>Omnia</title></head></html>"))
  return Effect.die(`unexpected embedded UI path: ${path}`)
}

function serve(path: string) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return yield* serveEmbeddedUIEffect(path, { ...fs, readFile }, embedded).pipe(
      Effect.map(HttpServerResponse.toWeb),
    )
  })
}

describe("mobile UI routing", () => {
  it.live("/mobile, /mobile/ and /mobile.html serve the mobile document", () =>
    Effect.gen(function* () {
      for (const path of ["/mobile", "/mobile/", "/mobile.html"]) {
        const response = yield* serve(path)
        expect(response.status).toBe(200)
        expect(yield* Effect.promise(() => response.text())).toContain("<title>Omnia Mobile</title>")
      }
    }),
  )

  it.live("an unknown path still falls back to the workspace document", () =>
    Effect.gen(function* () {
      const response = yield* serve("/mobile-typo")
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.text())).toContain("<title>Omnia</title>")
    }),
  )
})
