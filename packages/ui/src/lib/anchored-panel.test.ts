import { describe, expect, it } from "vitest"
import { placeAnchoredPanel } from "./anchored-panel"

const viewport = { width: 1000, height: 800 }

function triggerAt(partial: Partial<{ left: number; top: number; width: number; height: number }>) {
  const left = partial.left ?? 100
  const top = partial.top ?? 100
  const width = partial.width ?? 32
  const height = partial.height ?? 32
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  }
}

describe("placeAnchoredPanel", () => {
  it("places below when there is room", () => {
    const result = placeAnchoredPanel({
      trigger: triggerAt({ top: 100 }),
      panel: { width: 160, height: 120 },
      viewport,
    })
    expect(result.placement).toBe("below")
    expect(result.top).toBe(100 + 32 + 4)
  })

  it("flips above when below is tight and above has more room", () => {
    const result = placeAnchoredPanel({
      trigger: triggerAt({ top: 720 }),
      panel: { width: 160, height: 120 },
      viewport,
    })
    expect(result.placement).toBe("above")
    expect(result.top).toBeLessThan(720)
  })

  it("end-aligns to the trigger right edge", () => {
    const result = placeAnchoredPanel({
      trigger: triggerAt({ left: 400, width: 40 }),
      panel: { width: 160, height: 80 },
      align: "end",
      viewport,
    })
    expect(result.left).toBe(400 + 40 - 160)
  })

  it("clamps into the viewport horizontally", () => {
    const result = placeAnchoredPanel({
      trigger: triggerAt({ left: 20, width: 40 }),
      panel: { width: 200, height: 80 },
      align: "end",
      viewport,
    })
    expect(result.left).toBe(8)
  })

  it("pins to the top pad when the panel is taller than the viewport", () => {
    const result = placeAnchoredPanel({
      trigger: triggerAt({ top: 10, height: 20 }),
      panel: { width: 160, height: 400 },
      viewport: { width: 1000, height: 200 },
    })
    expect(result.top).toBe(8)
  })
})
