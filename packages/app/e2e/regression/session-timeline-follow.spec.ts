import { expect, test, type Locator, type Page } from "@playwright/test"

import {
  assistantMessage,
  completedAssistantInfo,
  messageUpdated,
  partDelta,
  partUpdated,
  reasoningPart,
  setupTimeline,
  shell,
  status,
  textPart,
  userMessage,
} from "../performance/timeline-stability/fixture"

// A row's height follows the ResizeObserver measurement of its content one frame
// later, so a wrapped line can settle by roughly a line (~22px). The jerk this
// guards against was far larger: the streaming row's rendered height dropped by
// 125px every couple of hundred milliseconds when its renderer was rebuilt on each
// tick, and every drop dragged the pinned viewport up with it.
const MAX_UPWARD_STEP_PX = 40
// How far behind the end the follow may fall while content streams in.
const MAX_DISTANCE_PX = 160

type ScrollSample = { top: number; distance: number }

// A frame sampler, not a poll: the jerk this guards against lasts a frame or two,
// so the viewport has to be read at every render opportunity to see it at all.
async function startSampling(scroller: Locator) {
  await scroller.evaluate((element) => {
    const root = element as HTMLElement
    const state = window as Window & { __followSamples?: unknown[]; __followStop?: boolean }
    const samples: unknown[] = []
    state.__followSamples = samples
    state.__followStop = false
    const tick = () => {
      if (state.__followStop) return
      samples.push({ top: root.scrollTop, distance: root.scrollHeight - root.clientHeight - root.scrollTop })
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

async function stopSampling(page: Page): Promise<ScrollSample[]> {
  return page.evaluate(() => {
    const state = window as Window & { __followSamples?: ScrollSample[]; __followStop?: boolean }
    state.__followStop = true
    return state.__followSamples ?? []
  })
}

function measure(samples: ScrollSample[]) {
  return samples.reduce(
    (result, sample, index) => {
      const previous = samples[index - 1]
      const upward = previous ? previous.top - sample.top : 0
      if (upward > result.maxUpward) {
        result.maxUpward = upward
        result.worst = { index, from: previous?.top ?? 0, to: sample.top }
      }
      result.maxDistance = Math.max(result.maxDistance, sample.distance)
      return result
    },
    { maxUpward: 0, maxDistance: 0, worst: { index: -1, from: 0, to: 0 } },
  )
}

test("keeps the bottom pinned without moving the view up while the answer streams", async ({ page }) => {
  const shellID = "prt_follow_shell"
  const reasoningID = "prt_follow_reasoning"
  const textID = "prt_follow_text"
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage(
        [
          reasoningPart(reasoningID, "Reading the failing test first."),
          shell(shellID, "running", "preparing"),
          textPart(textID, "Starting the run."),
        ],
        { completed: false },
      ),
    ],
    settings: { shellToolPartsExpanded: true, showReasoningSummaries: false },
    cpuRate: 4,
    seedHistory: true,
  })
  const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
  const distance = () =>
    scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)

  // Start from a settled, end-anchored viewport: the contract below is about
  // following, so the measurement only begins once the follow is established.
  await expect.poll(distance).toBeLessThanOrEqual(2)
  await timeline.waitForPart(textID)
  await startSampling(scroller)

  await timeline.send(status("busy"), 40)
  for (let index = 0; index < 12; index++) {
    await timeline.send(partDelta(reasoningID, ` Step ${index}: the assertion fails on the second pass.`), 40)
    await timeline.send(partDelta(textID, `\n\nFragment ${index}: the timeline grows under the viewport.`), 40)
    await timeline.send(
      partUpdated(shell(shellID, "running", Array.from({ length: 12 + index * 6 }, (_, line) => `line ${line}`).join("\n"))),
      50,
    )
  }
  await timeline.send(messageUpdated(completedAssistantInfo(assistantMessage().info)), 60)
  await timeline.send(status("idle"), 120)

  const samples = await stopSampling(page)
  const result = measure(samples)

  expect(samples.length, "the sampler must have observed the streaming window").toBeGreaterThan(60)
  expect(
    result.maxUpward,
    `the view moved up ${result.maxUpward}px at frame ${result.worst.index} (${result.worst.from} -> ${result.worst.to}) while the answer streamed`,
  ).toBeLessThanOrEqual(MAX_UPWARD_STEP_PX)
  expect(result.maxDistance, "the follow fell behind the end while content streamed").toBeLessThanOrEqual(MAX_DISTANCE_PX)

  await expect.poll(distance).toBeLessThanOrEqual(2)
  await expect(page.locator(`[data-timeline-part-id="${textID}"]`)).toContainText("Fragment 11")
})
