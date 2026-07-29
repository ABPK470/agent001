import { describe, expect, it } from "vitest"
import {
  clampFloatLeft,
  dropSlotFromFloatCoverage,
  markDragMoved,
  overlapWidthPx,
  resolveViewTabDrop,
  toIndexFromRemainingSlot,
  type ViewTabDragState,
} from "./view-tab-dnd"

describe("view-tab-dnd", () => {
  it("keeps the current slot until a peer is half covered", () => {
    const peers = [
      { left: 0, width: 100 },
      { left: 220, width: 100 },
    ]
    // Float in the home gap — stay at 1.
    expect(dropSlotFromFloatCoverage(peers, 110, 100, 1)).toBe(1)
    // ~20% of left peer — stay.
    expect(dropSlotFromFloatCoverage(peers, 90, 100, 1)).toBe(1)
    // ≥50% of left peer → hole moves before it.
    expect(dropSlotFromFloatCoverage(peers, 0, 80, 1)).toBe(0)
    // ~20% of right peer — stay.
    expect(dropSlotFromFloatCoverage(peers, 140, 100, 1)).toBe(1)
    // ≥50% of right peer → hole moves after it.
    expect(dropSlotFromFloatCoverage(peers, 170, 100, 1)).toBe(2)
  })

  it("can jump several tabs away when a distant peer is half covered", () => {
    const peers = [
      { left: 0, width: 80 },
      { left: 100, width: 80 },
      { left: 300, width: 80 },
      { left: 400, width: 80 },
    ]
    expect(dropSlotFromFloatCoverage(peers, 400, 80, 2)).toBe(4)
    expect(dropSlotFromFloatCoverage(peers, 0, 80, 2)).toBe(0)
    expect(dropSlotFromFloatCoverage(peers, 200, 80, 2)).toBe(2)
  })

  it("measures overlap widths", () => {
    expect(overlapWidthPx(0, 100, 50, 100)).toBe(50)
    expect(overlapWidthPx(0, 40, 50, 100)).toBe(0)
  })

  it("maps remaining slots to reorder toIndex", () => {
    expect(toIndexFromRemainingSlot(0)).toBe(0)
    expect(toIndexFromRemainingSlot(2)).toBe(2)
  })

  it("clamps the float so it cannot pass the add button", () => {
    expect(clampFloatLeft(50, 10, 200)).toBe(50)
    expect(clampFloatLeft(5, 10, 200)).toBe(10)
    expect(clampFloatLeft(250, 10, 200)).toBe(200)
  })

  it("marks movement past threshold", () => {
    const drag: ViewTabDragState = {
      viewId: "a",
      startX: 10,
      startY: 10,
      pointerId: 1,
      hasMoved: false,
      widthPx: 96,
      grabOffsetX: 20,
      floatTop: 40,
      homeSlot: 0,
      peerStrip: null,
    }
    expect(markDragMoved(drag, 14, 10)).toBe(false)
    expect(markDragMoved(drag, 23, 10)).toBe(true)
    expect(drag.hasMoved).toBe(true)
  })

  it("reorders only after a real drag", () => {
    const drag: ViewTabDragState = {
      viewId: "a",
      startX: 0,
      startY: 0,
      pointerId: 1,
      hasMoved: true,
      widthPx: 96,
      grabOffsetX: 20,
      floatTop: 40,
      homeSlot: 0,
      peerStrip: null,
    }
    expect(resolveViewTabDrop(drag, 2, 0)).toEqual({
      kind: "reorder",
      viewId: "a",
      toIndex: 2,
    })
  })

  it("activates on click without movement", () => {
    const drag: ViewTabDragState = {
      viewId: "b",
      startX: 0,
      startY: 0,
      pointerId: 1,
      hasMoved: false,
      widthPx: 96,
      grabOffsetX: 20,
      floatTop: 40,
      homeSlot: 1,
      peerStrip: null,
    }
    expect(resolveViewTabDrop(drag, 1, 0)).toEqual({
      kind: "activate",
      viewId: "b",
    })
  })
})
