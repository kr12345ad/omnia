import { describe, expect, test } from "bun:test"
import { SessionID } from "@/session/schema"
import { resolveSendMessageTarget } from "@/tool/send_message"

const caller = SessionID.make("ses_caller")
const parent = SessionID.make("ses_parent")

describe("send_message target resolution", () => {
  test("defaults to the immediate parent for a subagent", () => {
    expect(resolveSendMessageTarget({ caller, parentID: parent })).toEqual({ ok: true, id: parent })
  })

  test("uses an explicit target", () => {
    expect(resolveSendMessageTarget({ caller, parentID: parent, requested: "ses_other" })).toEqual({
      ok: true,
      id: SessionID.make("ses_other"),
    })
  })

  test("refuses to send to the calling session", () => {
    const result = resolveSendMessageTarget({ caller, parentID: parent, requested: caller })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("calling session")
  })

  test("explains how to target a session when there is no parent", () => {
    const result = resolveSendMessageTarget({ caller })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("sessionID explicitly")
  })
})
