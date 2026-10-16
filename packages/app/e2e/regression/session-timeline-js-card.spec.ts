import { expect, test } from "@playwright/test"
import { assistantMessage, setupTimeline, toolPart, userMessage } from "../performance/timeline-stability/fixture"

// A `JsCard` is a program inside a program: the model writes JavaScript as one
// string argument. The app compiles that program before the card is given a
// frame, with the same wrapper the frame builds, so the two halves of this —
// the script running, and code that cannot be compiled being refused — are
// checked here, in a real engine and a real sandboxed frame.

const program = (code: string) => ["root = Stack([card])", `card = JsCard("${code}", "Orbit", 200)`].join("\n")

function timeline(partID: string, code: string) {
  return {
    messages: [
      userMessage(),
      assistantMessage([toolPart(partID, "visualize", "completed", { code: program(code), title: "Orbit" })]),
    ],
  }
}

// A card that draws taller than the box the model gave it: 1200px of content in
// a 200px frame, with the offset it is scrolled to kept where a test can read it
// from outside the frame.
const overflowingCard = [
  "root.replaceChildren()",
  "const tall = document.createElement('div')",
  "tall.style.height = '1200px'",
  "tall.textContent = 'tall'",
  "root.appendChild(tall)",
  "const marker = document.createElement('p')",
  "marker.id = 'card-offset'",
  "marker.style.cssText = 'position:fixed;top:0;left:0'",
  "document.body.appendChild(marker)",
  "const show = () => { marker.textContent = String(Math.round(document.body.scrollTop)) }",
  "document.body.addEventListener('scroll', show)",
  "show()",
].join("\\n")

test("a JS card runs its script inside the frame and never prints it", async ({ page }) => {
  const partID = "prt_js_card_run"
  const code = [
    "root.replaceChildren()",
    "const note = document.createElement('p')",
    "note.textContent = 'drawn from the script'",
    "root.appendChild(note)",
  ].join("\\n")
  await setupTimeline(page, timeline(partID, code))

  const wrapper = page.locator(`[data-timeline-part-id="${partID}"]`)
  await expect(wrapper.locator('[data-slot="openui-js-card-frame"]')).toBeVisible()
  await expect(wrapper.locator('[data-slot="openui-js-card-error"]')).toHaveCount(0)

  // The script ran: this text exists only inside the card's own document, which
  // is what proves the frame builds the program the app compiled. The card is
  // inert until it is clicked into, so the reader's pointer never has to.
  await expect(page.frameLocator('[data-slot="openui-js-card-frame"]').locator("p")).toHaveText("drawn from the script")

  // The code stays out of the answer as text, like every other program.
  await expect(wrapper).not.toContainText("root.replaceChildren()")
})

test("a JS card whose code does not compile is reported instead of run", async ({ page }) => {
  const partID = "prt_js_card_invalid"
  // `cv` where the expression cannot continue — the same line, because a line of
  // its own would be a valid statement and a runtime failure instead.
  await setupTimeline(page, timeline(partID, "const at = 1 cv"))

  const wrapper = page.locator(`[data-timeline-part-id="${partID}"]`)
  const notice = wrapper.locator('[data-slot="openui-js-card-error"]')
  await expect(notice).toBeVisible()
  // The engine's own message, carried through so the code can be fixed.
  await expect(notice).toContainText("cv")

  // Nothing was given a frame, so the broken program never ran, and the failure
  // is the app's own surface rather than a document's.
  await expect(wrapper.locator('[data-slot="openui-js-card-frame"]')).toHaveCount(0)
  // The card keeps its title, so the answer still says which drawing failed.
  await expect(wrapper.locator('[data-slot="openui-js-card-title"]')).toHaveText("Orbit")
})

// The frame has an opaque origin, so `postMessage` is the only way a script that
// throws while running can reach the app at all. Until this channel works, a
// failure mid-run stays inside the card.
test("a script that throws while running is reported by the app", async ({ page }) => {
  const partID = "prt_js_card_throw"
  const code = ["root.replaceChildren()", "throw new Error('canvas is not defined')"].join("\\n")
  await setupTimeline(page, timeline(partID, code))

  const wrapper = page.locator(`[data-timeline-part-id="${partID}"]`)
  // That this text can appear at all is the proof the frame ran the program: the
  // message is the frame's, and nothing else in the app can produce it. It is
  // not asserted that the frame is visible first — a program that throws fails
  // within a frame tick of mounting, so that race is the test's, not the app's.
  const notice = wrapper.locator('[data-slot="openui-js-card-error"]')
  await expect(notice).toBeVisible()
  await expect(notice).toContainText("canvas is not defined")
  // The card's own document is gone: the failure is the answer's to show.
  await expect(wrapper.locator('[data-slot="openui-js-card-frame"]')).toHaveCount(0)
})

// A card is often taller than the box the model gave it, and then a wheel over it
// is the card's gesture rather than the answer's. The frame stays inert, so the
// app takes the wheel from the browser for as long as the box the frame reported
// still has room, and leaves it to the answer once it does not: scrolling the
// card instead of the chat is exactly that decision, made per wheel.
test("wheeling over a card scrolls the card, and the answer at the card's end", async ({ page }) => {
  const partID = "prt_js_card_scroll"
  await setupTimeline(page, { ...timeline(partID, overflowingCard), seedHistory: true })

  const frame = page.locator('[data-slot="openui-js-card-frame"]')
  await expect(frame).toBeVisible()
  const offset = page.frameLocator('[data-slot="openui-js-card-frame"]').locator("#card-offset")
  await expect(offset).toHaveText("0")

  const answer = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
  const distance = () =>
    answer.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)
  // The answer starts pinned to its end, which is where a card at the bottom of a
  // conversation is read from.
  await expect.poll(distance).toBeLessThanOrEqual(2)

  const card = await frame.boundingBox()
  if (!card) throw new Error("the card has no box to point at")
  await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2)

  // Down is the card's: the card moves, and the answer it sits in does not.
  await page.mouse.wheel(0, 240)
  await expect.poll(async () => Number(await offset.textContent())).toBeGreaterThan(0)
  expect(await distance()).toBeLessThanOrEqual(2)

  // Up is the card's as well, back to its first pixel.
  await page.mouse.wheel(0, -240)
  await expect.poll(async () => Number(await offset.textContent())).toBeLessThanOrEqual(1)

  // And at that first pixel the gesture belongs to the answer again, from where
  // the card left it.
  await page.mouse.wheel(0, -240)
  await expect.poll(distance).toBeGreaterThan(0)
  expect(Number(await offset.textContent())).toBeLessThanOrEqual(1)
})

// A card the reader has entered owns the pointer, so the frame sees the wheel
// itself. It still cannot chain the gesture out of its own document, which is
// what the frame reports back to the app once its box ends.
test("a card the reader entered hands a wheel back to the answer at its end", async ({ page }) => {
  const partID = "prt_js_card_entered_scroll"
  await setupTimeline(page, { ...timeline(partID, overflowingCard), seedHistory: true })

  const frame = page.locator('[data-slot="openui-js-card-frame"]')
  await expect(frame).toBeVisible()
  const offset = page.frameLocator('[data-slot="openui-js-card-frame"]').locator("#card-offset")
  await expect(offset).toHaveText("0")

  const answer = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
  const distance = () =>
    answer.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)
  await expect.poll(distance).toBeLessThanOrEqual(2)

  const card = await frame.boundingBox()
  if (!card) throw new Error("the card has no box to point at")
  await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2)
  // The reader enters the card, which is the only way the frame gets the pointer.
  await page.locator('[data-slot="openui-js-card-pointer-gate"]').click()

  // The frame owns the wheel now, and scrolls its own box with it.
  await page.mouse.wheel(0, 240)
  await expect.poll(async () => Number(await offset.textContent())).toBeGreaterThan(0)
  expect(await distance()).toBeLessThanOrEqual(2)

  // Back to its first pixel, still inside the frame.
  await page.mouse.wheel(0, -240)
  await expect.poll(async () => Number(await offset.textContent())).toBeLessThanOrEqual(1)

  // At that pixel the frame has nothing left to scroll, so the rest of the
  // gesture continues in the answer instead of stopping dead at the edge.
  await page.mouse.wheel(0, -240)
  await expect.poll(distance).toBeGreaterThan(0)
})
