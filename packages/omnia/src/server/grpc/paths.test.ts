import { describe, expect, test } from "bun:test"
import { isKnownPath, modelPathString, parseModelPath, parseModelPathString } from "./paths"

function canonical(value: string): string {
  const path = parseModelPathString(value)
  expect(isKnownPath(path)).toBe(true)
  return modelPathString(path)
}

describe("Omnia model paths", () => {
  test("accepts the documented root, server, session, chat and configuration paths", () => {
    expect(canonical("/omnia")).toBe("/omnia")
    expect(canonical("/omnia/server/execution")).toBe("/omnia/server/execution")
    expect(canonical("/omnia/server/execution/last")).toBe("/omnia/server/execution/last")
    expect(canonical("/omnia/computers")).toBe("/omnia/computers")
    expect(canonical("/omnia/sessions")).toBe("/omnia/sessions")
    expect(canonical("/omnia/chat/channels")).toBe("/omnia/chat/channels")
    expect(canonical("/omnia/config/permissions/SECRETS/state")).toBe(
      "/omnia/config/permissions/scope[name=SECRETS]/state",
    )
  })

  test("normalizes the shorthand computer and session list forms to YANG list elements", () => {
    expect(canonical("/omnia/computers/PC-1/status")).toBe("/omnia/computers/computer[id=PC-1]/status")
    expect(canonical("/omnia/computers/computer[id=PC-1]/capabilities")).toBe(
      "/omnia/computers/computer[id=PC-1]/capabilities",
    )
    expect(canonical("/omnia/sessions/s1")).toBe("/omnia/sessions/session[id=s1]")
  })

  test("rejects paths that are not rooted at the Omnia model", () => {
    expect(() => parseModelPathString("/other")).toThrow()
  })

  test("rejects unknown or oversized model paths", () => {
    expect(isKnownPath(parseModelPathString("/omnia/nope"))).toBe(false)
    expect(isKnownPath(parseModelPathString("/omnia/server/status/extra"))).toBe(false)
  })

  test("requires a list key when selecting a child of a keyed list entry", () => {
    expect(isKnownPath(parseModelPathString("/omnia/computers/computer/status"))).toBe(false)
    expect(isKnownPath(parseModelPathString("/omnia/config/permissions/scope/state"))).toBe(false)
  })

  test("rejects empty list keys", () => {
    expect(() => parseModelPathString("/omnia/computers/computer[id=]/status")).toThrow()
  })

  test("rejects keys on containers and leaves", () => {
    expect(() => parseModelPathString("/omnia/server[name=x]/status")).toThrow()
  })

  test("rejects unknown keys on modeled lists", () => {
    expect(() => parseModelPathString("/omnia/computers/computer[id=x,foo=y]/status")).toThrow()
  })

  test("rejects an unsupported origin", () => {
    expect(() =>
      parseModelPath(undefined, { origin: "openconfig", elem: [{ name: "omnia" }] }),
    ).toThrow()
  })
})
