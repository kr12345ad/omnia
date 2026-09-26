import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { configFromEnv } from "@/tool/computer/client"
import { Parameters as ObserveParameters } from "@/tool/computer/observe"
import { Parameters as FindParameters } from "@/tool/computer/find"
import { Parameters as ActParameters } from "@/tool/computer/act"

const decodeObserve = Schema.decodeUnknownSync(ObserveParameters)
const decodeFind = Schema.decodeUnknownSync(FindParameters)
const decodeAct = Schema.decodeUnknownSync(ActParameters)

describe("computer server config", () => {
  test("refuses to run without an Omnia Server", () => {
    const url = process.env.OMNIA_SERVER_URL
    const token = process.env.OMNIA_SERVER_TOKEN
    const computer = process.env.OMNIA_COMPUTER_ID
    delete process.env.OMNIA_SERVER_URL
    delete process.env.OMNIA_SERVER_TOKEN
    delete process.env.OMNIA_COMPUTER_ID
    try {
      expect(() => Effect.runSync(configFromEnv())).toThrow("Omnia Server is not running")
    } finally {
      if (url !== undefined) process.env.OMNIA_SERVER_URL = url
      if (token !== undefined) process.env.OMNIA_SERVER_TOKEN = token
      if (computer !== undefined) process.env.OMNIA_COMPUTER_ID = computer
    }
  })

  test("reads server coordinates from the environment", () => {
    process.env.OMNIA_SERVER_URL = "http://127.0.0.1:1"
    process.env.OMNIA_SERVER_TOKEN = "token"
    process.env.OMNIA_COMPUTER_ID = "linux-host"
    try {
      expect(Effect.runSync(configFromEnv())).toEqual({
        url: "http://127.0.0.1:1",
        token: "token",
        computerId: "linux-host",
      })
    } finally {
      delete process.env.OMNIA_SERVER_URL
      delete process.env.OMNIA_SERVER_TOKEN
      delete process.env.OMNIA_COMPUTER_ID
    }
  })
})

describe("computer tool schemas", () => {
  test("observe accepts empty params", () => {
    expect(decodeObserve({})).toEqual({})
  })

  test("find requires a query", () => {
    expect(() => decodeFind({})).toThrow()
    expect(decodeFind({ query: "Export" })).toEqual({ query: "Export" })
  })

  test("act accepts a target or a semantic query", () => {
    expect(decodeAct({ action: "click", target: "atspi:3.5" })).toEqual({
      action: "click",
      target: "atspi:3.5",
    })
    expect(decodeAct({ action: "click", query: "Export button" })).toEqual({
      action: "click",
      query: "Export button",
    })
    expect(decodeAct({ action: "read_text", query: "document text" })).toEqual({
      action: "read_text",
      query: "document text",
    })
    expect(decodeAct({ action: "write_clipboard", text: "hello" })).toEqual({
      action: "write_clipboard",
      text: "hello",
    })
    expect(() => decodeAct({ action: "not_a_real_action" })).toThrow()
  })
})
