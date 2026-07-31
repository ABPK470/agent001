import { describe, expect, it } from "vitest"
import { placeTruncationHint } from "./TruncationHint"

const viewport = { width: 1000, height: 800 }

function anchorAt(partial: { left: number; right: number; top?: number; height?: number }) {
  return {
    top: partial.top ?? 200,
    height: partial.height ?? 24,
    left: partial.left,
    right: partial.right,
  }
}

describe("placeTruncationHint", () => {
  it("opens to the right when there is room", () => {
    const placed = placeTruncationHint({
      anchor: anchorAt({ left: 40, right: 200 }),
      viewport,
    })
    expect(placed.side).toBe("right")
    expect(placed.left).toBe(210)
    expect(placed.maxWidth).toBeGreaterThan(160)
  })

  it("flips left when the trigger sits on the right edge (Threads runs)", () => {
    // Trigger near the right of the viewport — default right side leaves ~30px.
    const placed = placeTruncationHint({
      anchor: anchorAt({ left: 700, right: 960 }),
      prefer: "right",
      viewport,
    })
    expect(placed.side).toBe("left")
    expect(placed.right).toBe(1000 - 700 + 10)
    expect(placed.maxWidth).toBeGreaterThanOrEqual(160)
    // Must not collapse into a vertical strip.
    expect(placed.maxWidth).toBeGreaterThan(100)
  })

  it("honors prefer=left when that side has room", () => {
    const placed = placeTruncationHint({
      anchor: anchorAt({ left: 400, right: 560 }),
      prefer: "left",
      viewport,
    })
    expect(placed.side).toBe("left")
  })

  it("caps maxWidth to available space on the chosen side", () => {
    const placed = placeTruncationHint({
      anchor: anchorAt({ left: 200, right: 920 }),
      prefer: "right",
      viewport,
    })
    // spaceRight ≈ 62, spaceLeft ≈ 182 → flip left; width capped to left room.
    expect(placed.side).toBe("left")
    expect(placed.maxWidth).toBe(200 - 10 - 8)
    expect(placed.maxWidth).toBeLessThanOrEqual(22 * 16)
  })
})
