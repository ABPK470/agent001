import { describe, expect, it } from "vitest"
import { STICKY_GOAL_HOME_OFFSET_PX, STICKY_GOAL_HOME_TOP } from "../../components/StickyUserGoal.js"
import {
  computeGoalStuck,
  goalPinLayout,
  userGoalPinSlotClass,
  userGoalTextClass,
} from "./goalPin.js"

describe("goalPinLayout", () => {
  it("aligns home stick offset with StickyUserGoal top-3.5", () => {
    const home = goalPinLayout("home")
    expect(home.stickyOffsetPx).toBe(STICKY_GOAL_HOME_OFFSET_PX)
    expect(home.stickyOffsetPx).toBe(14)
    expect(home.topClass).toBe(STICKY_GOAL_HOME_TOP)
    expect(home.stuckScrollThreshold).toBe(20)
  })

  it("uses py-5 inset for widget mode", () => {
    const widget = goalPinLayout("widget")
    expect(widget.stickyOffsetPx).toBe(20)
    expect(widget.topClass).toBe("top-5")
    expect(widget.stuckScrollThreshold).toBe(6)
  })
})

describe("computeGoalStuck", () => {
  const home = goalPinLayout("home")
  const widget = goalPinLayout("widget")

  it("stays unstuck near the top of the scroll host", () => {
    expect(
      computeGoalStuck("home", home, {
        hostTop: 100,
        hostBottom: 700,
        scrollTop: 0,
        sentinelBottom: 200,
        stickyTop: 114,
        stickyBottom: 150,
      }),
    ).toBe(false)
  })

  it("widget: stuck when sentinel has scrolled past the stick line", () => {
    expect(
      computeGoalStuck("widget", widget, {
        hostTop: 100,
        hostBottom: 700,
        scrollTop: 40,
        sentinelBottom: 100 + widget.stickyOffsetPx,
        stickyTop: 120,
        stickyBottom: 160,
      }),
    ).toBe(true)
    expect(
      computeGoalStuck("widget", widget, {
        hostTop: 100,
        hostBottom: 700,
        scrollTop: 40,
        sentinelBottom: 100 + widget.stickyOffsetPx + 1,
        stickyTop: 120,
        stickyBottom: 160,
      }),
    ).toBe(false)
  })

  it("home: requires sentinel past + sticky visible at stick line", () => {
    const stickLine = 100 + home.stickyOffsetPx
    expect(
      computeGoalStuck("home", home, {
        hostTop: 100,
        hostBottom: 700,
        scrollTop: 40,
        sentinelBottom: stickLine - 10,
        stickyTop: stickLine,
        stickyBottom: stickLine + 40,
      }),
    ).toBe(true)

    // Sticky scrolled out of the host — no unpin dot
    expect(
      computeGoalStuck("home", home, {
        hostTop: 100,
        hostBottom: 700,
        scrollTop: 40,
        sentinelBottom: stickLine - 10,
        stickyTop: 50,
        stickyBottom: 90,
      }),
    ).toBe(false)
  })
})

describe("user goal pin slot contract", () => {
  it("unpinned text reserves the pin gutter; pinned fills it", () => {
    expect(userGoalTextClass(false)).toBe("max-w-[calc(100%-2.5rem)]")
    expect(userGoalTextClass(true)).toBe("")
    expect(userGoalPinSlotClass()).toBe("w-10")
  })
})
