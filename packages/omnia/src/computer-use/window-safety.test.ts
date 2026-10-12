import { describe, expect, test } from "bun:test"
import { checkCloseGuard, checkTitleBarBan, CLOSE_GUARD_DISTANCE_PX, evaluateClickRisk, findKnownClosePoints, isTitleBarPoint } from "./window-safety"

// P0 regression context (docs/computer-use-reliability.md): a semantic over-match
// once fed a blind bounds-center click on the kitty window, which hit Close
// instead of Minimize and then reported "Verified".
const screen1080 = { width: 1920, height: 1080 }
const kittyTitle = "OC | Quick hello"
const closeBounds = { x: 1843, y: 45, width: 46, height: 32 }
const minimizeBounds = { x: 1834, y: 45, width: 46, height: 32 }

describe("computer-use window safety (P0 title-bar ban)", () => {
  test("bans the recorded Minimize point that missed 9px from Close", () => {
    expect(checkTitleBarBan({ point: { x: 1834, y: 45 }, image: screen1080 }).banned).toBe(true)
    expect(isTitleBarPoint({ x: 1834, y: 45 }, screen1080)).toBe(true)
    expect(checkCloseGuard({ x: 1834, y: 45 }, findKnownClosePoints(undefined, screen1080)).safe).toBe(false)
  })

  test("a bounds-center click on a title-bar-adjacent control is refused", () => {
    // The recorded failure: the window names itself, the control sits in the
    // title strip 9px from Close, and the aim is only the centre of its bounds.
    const ban = checkTitleBarBan({
      point: { x: 1857, y: 61 },
      image: screen1080,
      aim: { x: 1857, y: 61, strategy: "bounds-center" },
      elementRole: "button",
      elementName: "Minimize",
      bounds: minimizeBounds,
      windowTitle: kittyTitle,
    })
    expect(ban.banned).toBe(true)
    expect(ban.reason).toContain("center-guess on a titled control")

    // The same click without a window title is still refused: the control is a
    // title-bar button and the aim is not the role inset that separates it
    // from its neighbours.
    const untitled = checkTitleBarBan({
      point: { x: 1857, y: 61 },
      image: screen1080,
      aim: { x: 1857, y: 61, strategy: "bounds-center" },
      elementRole: "button",
      elementName: "Minimize",
      bounds: minimizeBounds,
    })
    expect(untitled.banned).toBe(true)
    expect(untitled.reason).toContain("role inset")

    // No opt-in or trusted crop can admit it.
    const optedIn = checkTitleBarBan({
      point: { x: 1857, y: 61 },
      image: screen1080,
      allowTitleBarClicks: true,
      crop: true,
      aim: { x: 1857, y: 61, strategy: "bounds-center" },
      elementRole: "button",
      elementName: "Minimize",
      bounds: minimizeBounds,
      windowTitle: kittyTitle,
    })
    expect(optedIn.banned).toBe(true)
  })

  test("the resolve ref instead of guessing path stays refused by the close guard", () => {
    expect(CLOSE_GUARD_DISTANCE_PX).toBe(25)
    const closes = findKnownClosePoints(undefined, screen1080)
    expect(checkCloseGuard({ x: 1843, y: 45 }, closes).safe).toBe(false)
  })
})

describe("evaluateClickRisk", () => {
  test("a bounds-center aim on a titled control is high", () => {
    const risk = evaluateClickRisk({
      aim: { x: 1866, y: 61, strategy: "bounds-center" },
      elementRole: "button",
      elementName: "Close",
      bounds: closeBounds,
      windowTitle: kittyTitle,
    })
    expect(risk.risk).toBe("high")
    expect(risk.reason).toBe("center-guess on a titled control; Close/Minimize sit 9px apart")
  })

  test("the 46x32 close button at (1843,45) is high with bounds-center and low with role-inset", () => {
    const guessed = evaluateClickRisk({
      aim: { x: 1866, y: 61, strategy: "bounds-center" },
      elementRole: "close",
      elementName: "Close",
      bounds: closeBounds,
    })
    expect(guessed.risk).toBe("high")

    const inset = evaluateClickRisk({
      aim: { x: 1883, y: 61, strategy: "role-inset" },
      elementRole: "close",
      elementName: "Close",
      bounds: closeBounds,
      windowTitle: kittyTitle,
    })
    expect(inset.risk).toBe("low")
  })

  test("an 800x24 textfield at (10,40) with control-center is low", () => {
    const risk = evaluateClickRisk({
      aim: { x: 410, y: 52, strategy: "control-center" },
      elementRole: "textfield",
      elementName: "Command",
      bounds: { x: 10, y: 40, width: 800, height: 24 },
      windowTitle: kittyTitle,
    })
    expect(risk.risk).toBe("low")
    expect(risk.reason).toContain("control-center")
  })

  test("a window-control name with any strategy other than role-inset is high", () => {
    for (const name of ["Close", "Close button", "Minimize", "Maximize", "Restore window", "Close X"]) {
      expect(
        evaluateClickRisk({
          aim: { x: 1866, y: 61, strategy: "control-center" },
          elementName: name,
          bounds: closeBounds,
        }).risk,
      ).toBe("high")
    }
    // Role vocabulary from ./aim.
    for (const role of ["close", "minimizeButton", "maximize", "restore"]) {
      expect(
        evaluateClickRisk({
          aim: { x: 1866, y: 61, strategy: "focus-point" },
          elementRole: role,
          bounds: closeBounds,
        }).risk,
      ).toBe("high")
    }
    // A content button named after the thing it closes is not Close-X.
    expect(
      evaluateClickRisk({
        aim: { x: 30, y: 61, strategy: "control-center" },
        elementName: "Close sidebar",
        bounds: { x: 20, y: 500, width: 20, height: 20 },
      }).risk,
    ).toBe("low")
  })

  test("a bounds-center aim within 24px of the title-bar corner is high", () => {
    // Just outside the right edge of the corner region, and one jitter step in.
    const near = evaluateClickRisk({
      aim: { x: 1500, y: 100, strategy: "bounds-center" },
      elementRole: "button",
      elementName: "Toggle",
      bounds: { x: 1490, y: 100, width: 40, height: 20 },
    })
    expect(near.risk).toBe("high")
    expect(near.reason).toContain("top-right")

    // The same corner geometry aimed from metadata resolves instead of guessing.
    const resolved = evaluateClickRisk({
      aim: { x: 1500, y: 110, strategy: "control-center" },
      elementRole: "button",
      elementName: "Toggle",
      bounds: { x: 1490, y: 100, width: 40, height: 20 },
    })
    expect(resolved.risk).toBe("low")
  })

  test("an unresolvable element is medium, not high", () => {
    const anonymous = evaluateClickRisk({
      aim: { x: 410, y: 52, strategy: "control-center" },
      bounds: { x: 10, y: 40, width: 800, height: 24 },
    })
    expect(anonymous.risk).toBe("medium")
    expect(anonymous.reason).toContain("unresolvable element")

    const degenerate = evaluateClickRisk({
      aim: { x: 0, y: 0, strategy: "bounds-center" },
      elementRole: "button",
      elementName: "Ghost",
      bounds: { x: 10, y: 40, width: 0, height: 0 },
    })
    expect(degenerate.risk).toBe("medium")

    const unknownStrategy = evaluateClickRisk({
      aim: { x: 410, y: 52, strategy: "telepathy" },
      elementRole: "textfield",
      elementName: "Command",
      bounds: { x: 10, y: 40, width: 800, height: 24 },
    })
    expect(unknownStrategy.risk).toBe("medium")
    expect(unknownStrategy.reason).toContain("outside the aim vocabulary")
  })
})

describe("click-risk gate in the safety verdict", () => {
  const commandField = { x: 10, y: 40, width: 800, height: 24 }

  test("a high risk is refused even with an opt-in and a trusted crop", () => {
    const ban = checkTitleBarBan({
      point: { x: 1857, y: 61 },
      image: { ...screen1080, serverCrop: true },
      allowTitleBarClicks: true,
      aim: { x: 1857, y: 61, strategy: "bounds-center" },
      elementRole: "button",
      elementName: "Close",
      bounds: closeBounds,
      windowTitle: kittyTitle,
    })
    expect(ban.banned).toBe(true)
    expect(ban.reason).toBe("center-guess on a titled control; Close/Minimize sit 9px apart")
  })

  test("a medium risk is allowed but recorded in warnings", () => {
    const ban = checkTitleBarBan({
      point: { x: 410, y: 52 },
      image: screen1080,
      aim: { x: 410, y: 52, strategy: "control-center" },
      bounds: commandField,
    })
    expect(ban.banned).toBe(false)
    expect(ban.warnings?.length).toBe(1)
    expect(ban.warnings?.[0]).toContain("unresolvable element")
  })

  test("a low risk is allowed and carries no warnings", () => {
    const ban = checkTitleBarBan({
      point: { x: 410, y: 52 },
      image: screen1080,
      aim: { x: 410, y: 52, strategy: "control-center" },
      elementRole: "textfield",
      elementName: "Command",
      bounds: commandField,
      windowTitle: kittyTitle,
    })
    expect(ban.banned).toBe(false)
    expect(ban.warnings).toBeUndefined()
  })

  test("a title-bar point with no element metadata still bans on the region alone", () => {
    const ban = checkTitleBarBan({ point: { x: 1834, y: 45 }, image: screen1080, platform: "linux" })
    expect(ban.banned).toBe(true)
    expect(ban.reason).toContain("title-bar window-control region")
    expect(ban.warnings).toBeUndefined()
  })
})
