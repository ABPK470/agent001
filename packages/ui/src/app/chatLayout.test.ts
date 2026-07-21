import { describe, expect, it } from "vitest"
import {
  HOME_CHAT_COLUMN_CLASS,
  HOME_CHAT_GUTTER_X_CLASS,
  HOME_CHAT_INPUT_DOCK_CLASS,
  HOME_CHAT_MAX_WIDTH_PX,
  HOME_CHAT_WIDTH_RATIO,
  USER_GOAL_COLUMN_CLASS,
  USER_GOAL_PIN_SLOT_CLASS,
  USER_GOAL_TEXT_MAX_CLASS,
  USER_GOAL_TO_RESPONSE_GAP_CLASS,
  homeChatColumnWidthPx,
} from "./chatLayout.js"

describe("chatLayout — home + TermChat alignment", () => {
  it("column width caps at 960 and uses 94% of viewport", () => {
    expect(homeChatColumnWidthPx(2000)).toBe(HOME_CHAT_MAX_WIDTH_PX)
    expect(homeChatColumnWidthPx(800)).toBe(800 * HOME_CHAT_WIDTH_RATIO)
    expect(HOME_CHAT_COLUMN_CLASS).toContain("max-w-[960px]")
    expect(HOME_CHAT_COLUMN_CLASS).toContain("w-[94%]")
  })

  it("reserves pin slot outside the unpinned pill so text never shifts", () => {
    expect(USER_GOAL_PIN_SLOT_CLASS).toBe("w-10")
    expect(USER_GOAL_TEXT_MAX_CLASS).toBe("max-w-[calc(100%-2.5rem)]")
    expect(USER_GOAL_COLUMN_CLASS).toContain("max-w-[82%]")
    expect(USER_GOAL_TO_RESPONSE_GAP_CLASS).toBe("gap-6")
  })

  it("keeps home gutter + dock tokens stable", () => {
    expect(HOME_CHAT_GUTTER_X_CLASS).toBe("px-6")
    expect(HOME_CHAT_INPUT_DOCK_CLASS).toContain("px-6")
    expect(HOME_CHAT_INPUT_DOCK_CLASS).toContain("pb-4")
  })
})
