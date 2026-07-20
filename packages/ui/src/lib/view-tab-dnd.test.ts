import { describe, expect, it } from "vitest"
import {
  fullIndexFromRemainingSlot,
  markDragMoved,
  remainingSlotFromPointer,
  resolveViewTabDrop,
  syntheticPeerRects,
  tabIndexFromClientX,
  tabInsertSlotFromClientX,
  toIndexFromRemainingSlot,
  type ViewTabDragState,
} from "./view-tab-dnd"

describe("view-tab-dnd", () => {
  it("maps pointer X to tab index by midpoint", () => {
    const rects = [
      { left: 0, width: 100 },
      { left: 100, width: 100 },
      { left: 200, width: 100 },
    ]
    expect(tabIndexFromClientX(rects, 40)).toBe(0)
    expect(tabIndexFromClientX(rects, 140)).toBe(1)
    expect(tabIndexFromClientX(rects, 280)).toBe(2)
  })

  it("maps pointer X to insertion slots including after last", () => {
    const rects = [
      { left: 0, width: 100 },
      { left: 100, width: 100 },
      { left: 200, width: 100 },
    ]
    expect(tabInsertSlotFromClientX(rects, 40)).toBe(0)
    expect(tabInsertSlotFromClientX(rects, 160)).toBe(2)
    expect(tabInsertSlotFromClientX(rects, 280)).toBe(3)
  })

  it("remaining slots map to reorder toIndex and full-list ghost index", () => {
    // Drag index 1 out of [A,B,C,D] → peers [A,C,D]; home remaining slot = 1.
    expect(toIndexFromRemainingSlot(0)).toBe(0)
    expect(toIndexFromRemainingSlot(2)).toBe(2)
    expect(fullIndexFromRemainingSlot(1, 0)).toBe(0)
    expect(fullIndexFromRemainingSlot(1, 1)).toBe(1)
    expect(fullIndexFromRemainingSlot(1, 2)).toBe(3)
    expect(fullIndexFromRemainingSlot(1, 3)).toBe(4)
  })

  it("builds synthetic peer rects that ignore a live ghost", () => {
    const rects = syntheticPeerRects({
      originLeft: 100,
      gapPx: 4,
      peerWidths: [80, 90],
    })
    expect(rects).toEqual([
      { left: 100, width: 80 },
      { left: 184, width: 90 },
    ])
    expect(remainingSlotFromPointer({
      originLeft: 100,
      gapPx: 4,
      peerWidths: [80, 90],
    }, 120)).toBe(0)
    expect(remainingSlotFromPointer({
      originLeft: 100,
      gapPx: 4,
      peerWidths: [80, 90],
    }, 200)).toBe(1)
    expect(remainingSlotFromPointer({
      originLeft: 100,
      gapPx: 4,
      peerWidths: [80, 90],
    }, 300)).toBe(2)
  })

  it("marks movement past threshold", () => {
    const drag: ViewTabDragState = {
      viewId: "a",
      startX: 10,
      startY: 10,
      pointerId: 1,
      hasMoved: false,
      widthPx: 96,
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
      peerStrip: null,
    }
    expect(resolveViewTabDrop(drag, 1, 0)).toEqual({
      kind: "activate",
      viewId: "b",
    })
  })
})
