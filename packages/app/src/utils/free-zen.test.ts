import { beforeEach, describe, expect, test } from "bun:test"
import {
  activeFreeZenLimit,
  freeZenLimitFromStatus,
  freeZenResetsAt,
  recordFreeZenLimit,
} from "./free-zen"

const refused = {
  type: "retry",
  attempt: 1,
  message: "Free usage exceeded, subscribe to Go",
  action: {
    reason: "free_tier_limit",
    provider: "opencode",
    title: "Free limit reached",
    message: "Subscribe to OpenCode Go for reliable access to the best open-source models for $10/month.",
    label: "subscribe",
    link: "https://opencode.ai/go",
  },
  next: 1,
}

describe("free Zen limit", () => {
  beforeEach(() => {
    recordFreeZenLimit({ at: 1, resetsAt: 1 })
  })

  test("resets at the next UTC midnight, the instant the limiter's retry-after names", () => {
    const at = Date.parse("2026-10-31T23:30:00Z")

    expect(freeZenResetsAt(at)).toBe(Date.parse("2026-11-01T00:00:00Z"))
  })

  test("reads a free-tier refusal off the session status", () => {
    const at = Date.parse("2026-10-31T12:00:00Z")

    expect(freeZenLimitFromStatus({ ...refused, next: at + 5_000 }, at)).toEqual({
      at,
      resetsAt: Date.parse("2026-11-01T00:00:00Z"),
      provider: "opencode",
      message: "Subscribe to OpenCode Go for reliable access to the best open-source models for $10/month.",
    })
  })

  test("ignores a refusal whose retry is already in the past", () => {
    const at = Date.parse("2026-10-31T12:00:00Z")

    // A status loaded from an earlier run must not date today's reset.
    expect(freeZenLimitFromStatus({ ...refused, next: at - 1 }, at)).toBeUndefined()
    expect(freeZenLimitFromStatus(refused, Date.parse("2026-10-31T12:00:00Z") + 10_000)).toBeUndefined()
  })

  test("ignores every status that is not a free-tier refusal", () => {
    expect(freeZenLimitFromStatus({ type: "idle" })).toBeUndefined()
    expect(freeZenLimitFromStatus({ type: "busy" })).toBeUndefined()
    expect(
      freeZenLimitFromStatus({
        ...refused,
        action: { ...refused.action, reason: "account_rate_limit" },
      }),
    ).toBeUndefined()
  })

  test("a refusal stops applying once its day has reset", () => {
    const at = Date.parse("2026-10-31T23:30:00Z")
    const limit = freeZenLimitFromStatus({ ...refused, next: at + 5_000 }, at)

    recordFreeZenLimit(limit)

    expect(activeFreeZenLimit(Date.parse("2026-10-31T23:59:00Z"))).toEqual(limit)
    // 00:00 UTC is a new budget, so yesterday's "none left" must not be shown.
    expect(activeFreeZenLimit(Date.parse("2026-11-01T00:00:00Z"))).toBeUndefined()
  })
})
