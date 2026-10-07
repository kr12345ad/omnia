import { describe, expect, test } from "bun:test"
import { readPartText } from "./message-part-text"
import { discussionParticipantLabel, readDiscussionSpecialists } from "./message-part-discussion"

describe("readPartText", () => {
  test("returns empty string when accum is undefined and part text is undefined", () => {
    expect(readPartText(undefined, { id: "part_1" })).toBe("")
  })

  test("returns trimmed part text when accum is undefined", () => {
    expect(readPartText(undefined, { id: "part_1", text: "  hello  " })).toBe("hello")
  })

  test("prefers accum value over part text when accum has a hit", () => {
    expect(readPartText({ part_1: "  from accum  " }, { id: "part_1", text: "from part" })).toBe("from accum")
  })

  test("falls back to part text when accum misses", () => {
    expect(readPartText({ other_part: "ignored" }, { id: "part_1", text: "  from part  " })).toBe("from part")
  })

  test("returns empty string for whitespace-only text", () => {
    expect(readPartText(undefined, { id: "part_1", text: "   \n\t  " })).toBe("")
  })

  test("trims leading and trailing whitespace", () => {
    expect(readPartText(undefined, { id: "part_1", text: "\n  body  \n" })).toBe("body")
  })
})

describe("discussionParticipantLabel", () => {
  test("keeps the capitalized agent label for the default specialists and manager", () => {
    expect(discussionParticipantLabel({ agent: "discussion-strategist" })).toBe("Strategist")
    expect(discussionParticipantLabel({ agent: "discussion-manager" })).toBe("Manager")
    expect(
      discussionParticipantLabel({
        agent: "discussion-critic",
        title: "Discussion: t (@critic)",
        specialist: { role: "critic", name: "Ignored" },
      }),
    ).toBe("Critic")
  })

  test("prefers the display name for custom specialists", () => {
    expect(
      discussionParticipantLabel({
        agent: "discussion-specialist",
        title: "Discussion: t (@data-analyst)",
        specialist: { role: "data-analyst", name: "  Data Analyst  " },
      }),
    ).toBe("Data Analyst")
  })

  test("falls back to the role slug, then the session title, then the agent label", () => {
    expect(
      discussionParticipantLabel({ agent: "discussion-specialist", specialist: { role: "data-analyst", name: " " } }),
    ).toBe("data-analyst")
    expect(
      discussionParticipantLabel({ agent: "discussion-specialist", title: "Discussion: a (b) topic (@lawyer)" }),
    ).toBe("lawyer")
    expect(discussionParticipantLabel({ agent: "discussion-specialist", title: "Discussion: t" })).toBe("Specialist")
    expect(discussionParticipantLabel({})).toBe("Specialist")
  })
})

describe("readDiscussionSpecialists", () => {
  test("keeps well-formed entries and drops malformed ones", () => {
    expect(
      readDiscussionSpecialists([
        { role: "a", name: "A", sessionId: "ses_1" },
        { role: 1, name: null, sessionId: "ses_2" },
        { role: "c", name: "C" },
        "x",
        null,
      ]),
    ).toEqual([
      { role: "a", name: "A", sessionId: "ses_1" },
      { role: undefined, name: undefined, sessionId: "ses_2" },
    ])
    expect(readDiscussionSpecialists(undefined)).toEqual([])
  })
})
