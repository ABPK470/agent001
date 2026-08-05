import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, "useStickToBottomScroll.ts"), "utf8")

describe("useStickToBottomScroll — inspect polish", () => {
  it("restores VirtualList index/offset when interrupted content shrinks", () => {
    expect(src).toContain("listRef")
    expect(src).toContain("restoreScrollAnchor")
    expect(src).toContain("inspectAnchorRef")
    expect(src).toContain("scrollTopAfterHeightShrink")
  })

  it("uses hysteresis: interrupt away vs paper-band re-engage", () => {
    expect(src).toContain("CHAT_SCROLL_INTERRUPT_AWAY_PX")
    expect(src).toContain("chatScrollDistanceFromBottom")
    expect(src).toContain("dist <= threshold")
  })

  it("derives jump button from scroll position, not intent alone", () => {
    expect(src).toContain("chatTranscriptShowJumpButton")
    expect(src).toContain("syncJumpButtonFromHost")
    expect(src).not.toMatch(/setShowJumpButton\(next === "interrupted"\)/)
  })

  it("pins the floor synchronously on grow, then settles next frame", () => {
    expect(src).toContain("pinFloorWhileFollowing")
    expect(src).toMatch(/pinFloorWhileFollowing\(\)/)
    // Must not defer the first pin to rAF-only (paints a wrong scrollTop).
    expect(src).not.toMatch(/scheduleGrowStick/)
  })
})
