import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  CHAT_INPUT_PILL_CLASS,
  CHAT_INPUT_WIDGET_CLASS,
  CHAT_TRANSCRIPT_BOTTOM_PAPER_CLASS,
  CHAT_TRANSCRIPT_BOTTOM_PAPER_RATIO,
  CHAT_TRANSCRIPT_NEAR_BOTTOM_MIN_PX,
  chatTranscriptNearBottomThresholdPx,
  HOME_CHAT_COLUMN_CLASS,
  HOME_CHAT_GUTTER_X_CLASS,
  HOME_CHAT_INPUT_DOCK_CLASS,
  HOME_CHAT_MAX_WIDTH_PX,
  HOME_CHAT_WIDTH_RATIO,
  USER_GOAL_COLUMN_CLASS,
  USER_GOAL_PIN_SLOT_CLASS,
  USER_GOAL_TEXT_MAX_CLASS,
  USER_GOAL_TO_RESPONSE_GAP_CLASS,
  WIDGET_CHAT_INPUT_DOCK_CLASS,
  homeChatColumnWidthPx,
} from "./chatLayout.js"

const here = dirname(fileURLToPath(import.meta.url))

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

  it("home and widget composers share the bordered pill", () => {
    expect(CHAT_INPUT_PILL_CLASS).toContain("border border-border")
    expect(CHAT_INPUT_PILL_CLASS).not.toContain("ring-")
    expect(CHAT_INPUT_PILL_CLASS).toContain("chathome-chrome-pill")
    expect(WIDGET_CHAT_INPUT_DOCK_CLASS).toContain("widget-content-gutter")
    expect(WIDGET_CHAT_INPUT_DOCK_CLASS).not.toContain("border-t")
  })

  it("bottom paper leaves Cursor-like air; near-bottom tracks paper ratio", () => {
    expect(CHAT_TRANSCRIPT_BOTTOM_PAPER_CLASS).toBe("chat-transcript-bottom-paper")
    expect(CHAT_TRANSCRIPT_BOTTOM_PAPER_RATIO).toBe(0.38)
    expect(chatTranscriptNearBottomThresholdPx(100)).toBe(CHAT_TRANSCRIPT_NEAR_BOTTOM_MIN_PX)
    expect(chatTranscriptNearBottomThresholdPx(1000)).toBe(380)

    const css = readFileSync(join(here, "../boot/index.css"), "utf8")
    expect(css).toMatch(
      /\.chat-transcript-bottom-paper\s*\{[^}]*height:\s*clamp\(5\.5rem,\s*38vh,\s*22rem\)/s,
    )

    const term = readFileSync(join(here, "../widgets/TermChat.tsx"), "utf8")
    expect(term).toContain("CHAT_TRANSCRIPT_BOTTOM_PAPER_CLASS")
    expect(term).toContain("threshold: nearBottomThreshold")
    expect(term).toContain("chatTranscriptNearBottomThresholdPx")
    // Both home + widget list paths render the spacer.
    expect(term.match(/CHAT_TRANSCRIPT_BOTTOM_PAPER_CLASS/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
    // Tiny scrollport pad must not replace the paper.
    expect(term).not.toMatch(/showEmptyState \? "" : " pb-6"/)
  })
})
