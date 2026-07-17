import { describe, expect, it } from "vitest"
import {
  insertSlotWouldMove,
  markDragMoved,
  resolveViewTabDrop,
  tabIndexFromClientX,
  tabInsertSlotFromClientX,
  toIndexFromInsertSlot,
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

  it("converts insert slots to reorder toIndex", () => {
    expect(toIndexFromInsertSlot(0, 3)).toBe(2)
    expect(toIndexFromInsertSlot(2, 0)).toBe(0)
    expect(insertSlotWouldMove(1, 1)).toBe(false)
    expect(insertSlotWouldMove(1, 2)).toBe(false)
    expect(insertSlotWouldMove(1, 0)).toBe(true)
    expect(insertSlotWouldMove(1, 3)).toBe(true)
  })

  it("marks movement past threshold", () => {
    const drag: ViewTabDragState = {
      viewId: "a",
      startX: 10,
      startY: 10,
      pointerId: 1,
      hasMoved: false,
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
    }
    expect(resolveViewTabDrop(drag, 1, 0)).toEqual({
      kind: "activate",
      viewId: "b",
    })
  })
})
