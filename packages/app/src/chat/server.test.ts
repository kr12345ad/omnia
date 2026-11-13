import { describe, expect, test } from "bun:test"
import { chatAuthHeaders, chatPageBase, resolveChatServer } from "./server"

describe("chat server resolution", () => {
  test("an explicit server parameter wins and is normalized", () => {
    expect(
      resolveChatServer({
        param: "https://explicit.example/omnia///",
        injected: "https://injected.example",
        origin: "https://page.example",
      }),
    ).toBe("https://explicit.example/omnia")
  })

  test("a host-injected relative server URL resolves against the page base", () => {
    expect(
      resolveChatServer({
        injected: "/test1/omnia",
        origin: "https://page.example/test1/omnia",
      }),
    ).toBe("https://page.example/test1/omnia")
  })

  test("the dev server is the fallback while developing", () => {
    expect(
      resolveChatServer({
        origin: "http://localhost:3000",
        dev: { host: "127.0.0.1", port: "4096" },
      }),
    ).toBe("http://127.0.0.1:4096")
  })

  test("falls back to the page base and rejects non-http parameters", () => {
    expect(resolveChatServer({ origin: "https://page.example/test1/omnia" })).toBe(
      "https://page.example/test1/omnia",
    )
    expect(resolveChatServer({ param: "file:///tmp/chat.sock", origin: "https://page.example" })).toBe(
      "https://page.example",
    )
  })

  test("keeps the deployment prefix when the page is under a prefix", () => {
    expect(chatPageBase({ origin: "https://host", pathname: "/chat" })).toBe("https://host")
    expect(chatPageBase({ origin: "https://host", pathname: "/chat.html" })).toBe("https://host")
    expect(chatPageBase({ origin: "https://host", pathname: "/test1/omnia/chat" })).toBe(
      "https://host/test1/omnia",
    )
    expect(chatPageBase({ origin: "https://host", pathname: "/test1/omnia/chat/" })).toBe(
      "https://host/test1/omnia",
    )
    expect(chatPageBase({ origin: "https://host", pathname: "/" })).toBe("https://host")
    expect(chatPageBase({ origin: "https://host", pathname: "/index.html" })).toBe("https://host")
    expect(chatPageBase({ origin: "https://host", pathname: "/test1/omnia/index.html" })).toBe(
      "https://host/test1/omnia",
    )
    expect(chatPageBase({ origin: "https://host", pathname: "/mobile" })).toBe("https://host")
    expect(chatPageBase({ origin: "https://host", pathname: "/mobile.html" })).toBe("https://host")
    expect(chatPageBase({ origin: "https://host", pathname: "/test1/omnia/mobile" })).toBe(
      "https://host/test1/omnia",
    )
    expect(chatPageBase({ origin: "https://host", pathname: "/test1/omnia/mobile.html" })).toBe(
      "https://host/test1/omnia",
    )
  })
})

describe("chat auth", () => {
  test("turns the one-time auth token into basic credentials", () => {
    const token = btoa("opencode:secret")
    expect(chatAuthHeaders(token)).toEqual({
      Authorization: `Basic ${btoa("opencode:secret")}`,
    })
  })

  test("ignores a missing or malformed token", () => {
    expect(chatAuthHeaders(null)).toBeUndefined()
    expect(chatAuthHeaders("not-base64")).toBeUndefined()
    expect(chatAuthHeaders(btoa("no-colon"))).toBeUndefined()
  })
})
