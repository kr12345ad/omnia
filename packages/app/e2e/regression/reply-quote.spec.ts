import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

test.describe("replying to an answer", () => {
  test.setTimeout(180_000)

  test("quotes the answer into the composer so the question is about it", async ({ page }) => {
    await mockOpenCodeServer(page, {
      sessions: fixture.sessions,
      provider: fixture.provider,
      directory: fixture.directory,
      project: fixture.project,
      pageMessages,
    })
    // The project is opened by hand in a real run; seeding the same settings
    // keys the smoke suite uses is what makes the session route render.
    await page.addInitScript(() => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: {} }))
    })
    await page.addInitScript((directory) => {
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
    }, fixture.directory)

    await page.goto(`/${base64Encode(fixture.directory)}/session/${fixture.targetID}`)
    await expectSessionTitle(page, fixture.expected.targetTitle)

    const answer = page.locator('[data-component="text-part"]').last()
    await expect(answer).toBeVisible({ timeout: 60_000 })
    const firstLine = (await answer.innerText()).trim().split("\n")[0]!
    expect(firstLine.length).toBeGreaterThan(0)

    await answer.hover()
    const reply = page.locator('[aria-label="Reply"]').last()
    await expect(reply).toBeVisible({ timeout: 15_000 })
    await reply.click()

    const editor = page.locator('[data-component="prompt-input"]').last()
    await expect(editor).toContainText("Replying to this message:", { timeout: 15_000 })
    const draft = await editor.innerText()
    // The quote is the answer itself, not just a label above an empty draft.
    expect(draft).toContain(firstLine.slice(0, 24))
    // The caret is where the question goes: below the quote, in the composer.
    await expect(editor).toBeFocused()

    // Sending carries the quote: it is the message the model is asked about.
    const sent: string[] = []
    page.on("request", (request) => {
      if (request.method() !== "POST") return
      const body = request.postData() ?? ""
      if (body.includes("Replying to this message:")) sent.push(body)
    })
    await page.keyboard.type("does this still apply?")
    await page.keyboard.press("Enter")
    await expect.poll(() => sent.length, { timeout: 15_000 }).toBeGreaterThan(0)
    expect(sent[0]).toContain("does this still apply?")
  })
})
