import { describe, expect, test } from "bun:test"
import { dict } from "../i18n/en"

const source = await Bun.file(new URL("./paywall.tsx", import.meta.url)).text()
/** Comments legitimately mention "$15 a month" as an example, so code is checked alone. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

/** Every i18n key the component names, however it names it. */
function referencedKeys() {
  return [...new Set([...source.matchAll(/"(ui\.paywall\.[A-Za-z0-9.]+)"/g)].map((match) => match[1]))]
}

/** Keys passed with an explicit parameter object, plus the names supplied. */
function parameterizedCalls() {
  return [...source.matchAll(/i18n\.t\(\s*"(ui\.paywall\.[A-Za-z0-9.]+)"\s*,\s*\{([^}]*)\}/g)].map((match) => ({
    key: match[1],
    params: [...match[2].matchAll(/([A-Za-z0-9_]+)\s*:/g)].map((name) => name[1]),
  }))
}

function placeholders(value: string) {
  return [...value.matchAll(/{{\s*([A-Za-z0-9_]+)\s*}}/g)].map((match) => match[1]).sort()
}

describe("paywall copy", () => {
  test("every key the component references exists in the English dictionary", () => {
    const keys = referencedKeys()
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.filter((key) => !(key in dict))).toEqual([])
  })

  test("every paywall key resolves to non-empty English copy", () => {
    const empty = Object.keys(dict)
      .filter((key) => key.startsWith("ui.paywall."))
      .filter((key) => typeof dict[key] !== "string" || dict[key].trim() === "")
    expect(empty).toEqual([])
  })

  test("placeholders match the parameters the component supplies, so translators are never guessing", () => {
    const calls = parameterizedCalls()
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect({ key: call.key, placeholders: placeholders(dict[call.key] ?? "") }).toEqual({
        key: call.key,
        placeholders: [...call.params].sort(),
      })
    }
  })

  test("no plan name or price is hardcoded in the component", () => {
    expect([...code.matchAll(/\$\s?\d/g)].map((match) => match[0])).toEqual([])
    expect([...code.matchAll(/"(pro|business|enterprise)"/g)].map((match) => match[0])).toEqual([])
  })
})
