import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ChatChannelsService } from "./channels"

function tempFile(): { file: string; clean: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "omnia-channels-"))
  return { file: join(dir, "channels.json"), clean: () => rmSync(dir, { recursive: true, force: true }) }
}

describe("the channel store", () => {
  test("a second process never erases a channel it did not see", () => {
    const temp = tempFile()
    try {
      // Two Omnia processes share one file: the hosted control plane and a
      // desktop instance that loaded it before anything was connected.
      const desktop = new ChatChannelsService({ file: temp.file })
      const hosted = new ChatChannelsService({ file: temp.file })
      desktop.connect("discord", { botToken: "x" })
      hosted.connect("gchat", { credentials: "{}", audience: "https://example.test/webhook" })
      // The desktop side records a Discord message from its stale view; writing
      // that view back used to drop gchat from the file.
      desktop.recordMessage("discord")
      expect(hosted.list().map((channel) => channel.platform).sort()).toEqual(["discord", "gchat"])
      expect(desktop.get("gchat")?.credentials.audience).toBe("https://example.test/webhook")
      expect(desktop.get("discord")?.messageCount).toBe(1)
    } finally {
      temp.clean()
    }
  })

  test("a disconnect still removes exactly one platform", () => {
    const temp = tempFile()
    try {
      const store = new ChatChannelsService({ file: temp.file })
      store.connect("discord", { botToken: "x" })
      store.connect("slack", { botToken: "xoxb", signingSecret: "s" })
      expect(store.disconnect("slack")).toBe(true)
      expect(store.list().map((channel) => channel.platform)).toEqual(["discord"])
      expect(store.disconnect("slack")).toBe(false)
    } finally {
      temp.clean()
    }
  })
})
