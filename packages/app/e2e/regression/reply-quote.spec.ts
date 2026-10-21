import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

test.describe("replying to an answer", () => {
  test.setTimeout(180_000)

  test("attaches the answer to the question without writing it into the composer", async ({ page }) => {
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
      // The tabs announcement floats over the composer's bottom-right corner,
      // which is exactly where the reply card's dismiss button sits.
      localStorage.setItem("settings.v3", JSON.stringify({ general: { shouldDisplayTabsToast: false } }))
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

    // Reply and copy read as one pair hugging the answer's text edge: the
    // 24px button boxes inset their glyphs by 5px, so the group starts 5px
    // before the text and the two buttons sit 2px apart.
    const text = await answer.locator('[data-slot="text-part-body"]').boundingBox()
    const actions = await answer.locator('[data-slot="message-actions"]').boundingBox()
    const buttons = await answer.locator('[data-slot="message-actions"] button').all()
    const boxes = await Promise.all(buttons.map((button) => button.boundingBox()))
    expect(Math.abs(actions!.x + 5 - text!.x)).toBeLessThanOrEqual(1)
    expect(boxes).toHaveLength(2)
    expect(boxes[1]!.x - (boxes[0]!.x + boxes[0]!.width)).toBeLessThanOrEqual(4)
    expect(boxes[0]!.y).toBe(boxes[1]!.y)

    await reply.click()

    const editor = page.locator('[data-component="prompt-input"]').last()
    // The reply is a card above the composer, like the todo list; the answered
    // text is context for the send and never becomes text in the input.
    const card = page.locator('[data-component="session-reply-dock"]')
    await expect(card).toBeVisible({ timeout: 15_000 })
    await expect(card).toContainText(firstLine.slice(0, 24))
    await expect(editor).not.toContainText("Replying to this message:")
    await expect(editor).not.toContainText(firstLine.slice(0, 24))
    const cardBox = await card.boundingBox()
    const editorBox = await editor.boundingBox()
    expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(editorBox!.y + 1)
    await expect(editor).toBeFocused()

    // Dismissing just drops the context; the draft is untouched.
    await card.locator('[data-action="session-reply-dismiss"]').click()
    await expect(card).toHaveCount(0)

    // Reply again and send: the quote rides with the request, not the input.
    await answer.hover()
    await page.locator('[aria-label="Reply"]').last().click()
    await expect(card).toBeVisible({ timeout: 15_000 })
    const sent: string[] = []
    page.on("request", (request) => {
      if (request.method() !== "POST") return
      const body = request.postData() ?? ""
      if (body.includes("Replying to this message:")) sent.push(body)
    })
    await expect(editor).toBeFocused()
    await page.keyboard.type("does this still apply?", { delay: 20 })
    await page.keyboard.press("Enter")
    await expect.poll(() => sent.length, { timeout: 15_000 }).toBeGreaterThan(0)
    expect(sent[0]).toContain("does this still apply?")
    expect(sent[0]).toContain(firstLine.slice(0, 24))
    await expect(card).toHaveCount(0)

    // The sent message carries the same card above the reply text, and the
    // raw Markdown quote never reaches the timeline.
    const message = page.locator('[data-component="user-message"]', { hasText: "does this still apply?" })
    const messageCard = message.locator('[data-slot="user-message-reply"]')
    await expect(messageCard).toBeVisible({ timeout: 15_000 })
    await expect(messageCard).toContainText(firstLine.slice(0, 24))
    await expect(message.locator('[data-slot="user-message-text"]')).toHaveText("does this still apply?")
    await expect(message).not.toContainText("Replying to this message:")
  })
})
