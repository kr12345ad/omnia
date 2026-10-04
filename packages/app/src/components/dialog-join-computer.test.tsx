import { describe, expect, mock, test } from "bun:test"

// dialog-join-computer.tsx pulls in Solid components and app contexts that are
// irrelevant to code normalization; stub them so the module can be imported in
// a plain Bun test.
mock.module("@opencode-ai/ui/button", () => ({ Button: () => null }))
mock.module("@opencode-ai/ui/dialog", () => ({ Dialog: () => null }))
mock.module("@opencode-ai/ui/text-field", () => ({ TextField: () => null }))
mock.module("@opencode-ai/ui/context/dialog", () => ({ useDialog: () => ({ close: () => undefined }) }))
mock.module("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
mock.module("@/context/platform", () => ({ usePlatform: () => ({ computers: undefined }) }))

const { normalizeJoinCode } = await import("./dialog-join-computer")

describe("normalizeJoinCode", () => {
  test("normalizes dashed and undashed eight-character codes", () => {
    expect(normalizeJoinCode("abcd-efgh")).toBe("ABCD-EFGH")
    expect(normalizeJoinCode("ABCDEFGH")).toBe("ABCD-EFGH")
    expect(normalizeJoinCode("  abcd efgh  ")).toBe("ABCD-EFGH")
  })

  test("rejects codes that are not exactly eight characters", () => {
    expect(normalizeJoinCode("")).toBe("")
    expect(normalizeJoinCode("ABCD-EFG")).toBe("")
    expect(normalizeJoinCode("ABCD-EFGHI")).toBe("")
  })

  test("rejects full URLs and paired address inputs", () => {
    expect(normalizeJoinCode("192.168.1.5:42035#ABCD-EFGH")).toBe("")
    expect(normalizeJoinCode("https://openfoodpantry.org/test1/omnia#ABCD-EFGH")).toBe("")
    expect(normalizeJoinCode("https://openfoodpantry.org/test1/omnia")).toBe("")
  })
})
