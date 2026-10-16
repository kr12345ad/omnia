import { expect, test } from "@playwright/test"
import {
  assistantMessage,
  partUpdated,
  setupTimeline,
  toolPart,
  userMessage,
} from "../performance/timeline-stability/fixture"

// The program travels in the call's own arguments, so it must never reach the
// transcript as text: a generic tool row would print `code=root = Card(...)` and
// no drawing, which is exactly what these assertions rule out.
const program = 'root = Card([CardHeader("Shipments"), TextContent("Rows shipped")])'
const input = { code: program, title: "Weekly report" }

test("draws a completed visualization from the tool call instead of printing the program", async ({ page }) => {
  const partID = "prt_visualize_completed"
  await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([toolPart(partID, "visualize", "completed", input)])],
  })

  const wrapper = page.locator(`[data-timeline-part-id="${partID}"]`)
  const drawing = wrapper.locator('[data-component="visualize-part"]')

  await expect(drawing).toBeVisible()
  await expect(drawing.locator('[data-slot="visualize-part-title"]')).toHaveText("Weekly report")
  // Text that exists only in the program, so it proves the program was parsed
  // into components rather than echoed.
  await expect(drawing).toContainText("Shipments")
  await expect(drawing).toContainText("Rows shipped")

  // The parser's raw-source fallback and the program itself stay out of the row.
  await expect(page.locator('[data-component="openui-fallback"]')).toHaveCount(0)
  await expect(wrapper.locator("pre")).toHaveCount(0)
  await expect(wrapper).not.toContainText("root = Card(")
})

test("draws a streaming visualization without ever showing the program as text", async ({ page }) => {
  const partID = "prt_visualize_streaming"
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([toolPart(partID, "visualize", "running", input)], { completed: false }),
    ],
  })

  const wrapper = page.locator(`[data-timeline-part-id="${partID}"]`)
  const drawing = wrapper.locator('[data-component="visualize-part"]')

  await expect(drawing).toBeVisible()
  await expect(drawing).toContainText("Shipments")
  await expect(wrapper).not.toContainText("root = Card(")

  await timeline.send(partUpdated(toolPart(partID, "visualize", "completed", input)), 300)

  await expect(drawing).toBeVisible()
  await expect(drawing).toContainText("Rows shipped")
  await expect(page.locator('[data-component="openui-fallback"]')).toHaveCount(0)
  await expect(wrapper).not.toContainText("root = Card(")
})
