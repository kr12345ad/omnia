import { test } from "bun:test"

test("do not run tests from the repository root", () => {
  throw new Error("do not run tests from the repository root; run `bun test` from a package directory")
})
