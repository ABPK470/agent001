import { describe, expect, it } from "vitest"
import {
  COLS,
  applyEdgePin,
  clampRectToGrid,
  colWidth,
  contentHeight,
  findBestFit,
  placeNewTile,
  pixelsToGridRect,
  rectToPixels,
  resolveDragLayout,
  reclaimSpace,
  resolveOverlaps,
  rowsForHeight,
  snapDragRect,
  snapToCanvasEdges,
  viewportGridMetrics,
  type LayoutTile,
} from "./grid-math"
import { WIDGET_DEFAULTS } from "./widget-layout-defaults"
import { viewFromWire, viewToWire } from "./workspace-view"

describe("grid-math", () => {
  it("computes column width from container width", () => {
    expect(colWidth(1200)).toBe((1200 - 8 * 11) / 12)
  })

  it("maps grid rects to pixel rects", () => {
    const cw = colWidth(1200)
    const pixels = rectToPixels({ x: 1, y: 2, w: 3, h: 4 }, cw)
    expect(pixels.left).toBeGreaterThan(0)
    expect(pixels.top).toBeGreaterThan(0)
    expect(pixels.width).toBeGreaterThan(cw)
    expect(pixels.height).toBeGreaterThan(32)
  })

  it("findBestFit places the first tile full width", () => {
    const tile = findBestFit([], "a", "term-chat", WIDGET_DEFAULTS["term-chat"], 20)
    expect(tile).toMatchObject({ x: 0, y: 0, w: 12, h: 20 })
  })

  it("placeNewTile fills the viewport for the first widget", () => {
    const { tile } = placeNewTile([], "a", "term-chat", WIDGET_DEFAULTS["term-chat"], 18)
    expect(tile).toMatchObject({ x: 0, y: 0, w: COLS, h: 18 })
  })

  it("placeNewTile splits a full-screen tile when adding a second", () => {
    const first = placeNewTile([], "a", "term-chat", WIDGET_DEFAULTS["term-chat"], 16)
    const second = placeNewTile(first.tiles, "b", "run-status", WIDGET_DEFAULTS["run-status"], 16)
    expect(second.tiles).toHaveLength(2)
    const [left, right] = second.tiles
    expect(left!.w + right!.w).toBe(COLS)
    expect(left!.h).toBe(16)
    expect(right!.h).toBe(16)
  })

  it("findBestFit fills the largest gap when tiles exist", () => {
    const existing: LayoutTile[] = [{
      id: "one",
      type: "term-chat",
      x: 0,
      y: 0,
      w: 6,
      h: 4,
      minW: 2,
      minH: 2,
    }]
    const tile = findBestFit(existing, "two", "run-status", WIDGET_DEFAULTS["run-status"])
    expect(tile.x).toBeGreaterThanOrEqual(0)
    expect(tile.y).toBeGreaterThanOrEqual(0)
    expect(tile.w * tile.h).toBeGreaterThan(0)
  })

  it("contentHeight grows with stacked tiles", () => {
    const height = contentHeight([
      { x: 0, y: 0, w: 6, h: 4 },
      { x: 0, y: 4, w: 6, h: 3 },
    ])
    expect(height).toBe(7 * 32 + 6 * 8)
  })
})

describe("smart drag swap", () => {
  it("swaps positions when one tile is dragged over another", () => {
    const tiles: LayoutTile[] = [
      { id: "a", type: "term-chat", x: 0, y: 0, w: 6, h: 8, minW: 2, minH: 2 },
      { id: "b", type: "run-status", x: 6, y: 0, w: 6, h: 8, minW: 2, minH: 2 },
    ]
    const next = resolveDragLayout(
      tiles,
      "a",
      { x: 6, y: 0, w: 6, h: 8 },
      { x: 0, y: 0, w: 6, h: 8 },
      16,
    )
    const a = next.find((t) => t.id === "a")!
    const b = next.find((t) => t.id === "b")!
    expect(a).toMatchObject({ x: 6, y: 0, w: 6, h: 8 })
    expect(b).toMatchObject({ x: 0, y: 0, w: 6, h: 8 })
  })

  it("exchanges full slots when sizes differ so the canvas stays packed", () => {
    const tiles: LayoutTile[] = [
      { id: "chat", type: "term-chat", x: 8, y: 0, w: 4, h: 16, minW: 2, minH: 4 },
      { id: "status", type: "run-status", x: 0, y: 0, w: 8, h: 8, minW: 2, minH: 2 },
      { id: "sync", type: "env-sync", x: 0, y: 8, w: 8, h: 8, minW: 2, minH: 2 },
    ]
    const next = resolveDragLayout(
      tiles,
      "status",
      { x: 8, y: 0, w: 8, h: 8 },
      { x: 0, y: 0, w: 8, h: 8 },
      16,
    )
    const chat = next.find((t) => t.id === "chat")!
    const status = next.find((t) => t.id === "status")!
    const sync = next.find((t) => t.id === "sync")!
    expect(status).toMatchObject({ x: 8, y: 0, w: 4, h: 16 })
    expect(chat).toMatchObject({ x: 0, y: 0, w: 8, h: 8 })
    expect(sync).toMatchObject({ x: 0, y: 8, w: 8, h: 8 })
    const covered = next.reduce((sum, tile) => sum + tile.w * tile.h, 0)
    expect(covered).toBe(COLS * 16)
  })

  it("resolveOverlaps separates stacked tiles", () => {
    const tiles: LayoutTile[] = [
      { id: "a", type: "term-chat", x: 0, y: 0, w: 12, h: 16, minW: 2, minH: 2 },
      { id: "b", type: "run-history", x: 6, y: 0, w: 6, h: 8, minW: 2, minH: 2 },
    ]
    const next = resolveOverlaps(tiles, 16)
    const a = next.find((t) => t.id === "a")!
    const b = next.find((t) => t.id === "b")!
    expect(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y).toBe(false)
  })

  it("resolveOverlaps keeps a locked tile expanding westward into its neighbor", () => {
    const tiles: LayoutTile[] = [
      { id: "left", type: "term-chat", x: 0, y: 0, w: 6, h: 16, minW: 2, minH: 2 },
      { id: "right", type: "run-history", x: 4, y: 0, w: 8, h: 16, minW: 2, minH: 2 },
    ]
    const next = resolveOverlaps(tiles, 16, new Set(["right"]))
    const left = next.find((t) => t.id === "left")!
    const right = next.find((t) => t.id === "right")!
    expect(right).toMatchObject({ x: 4, w: 8 })
    expect(left.x + left.w).toBe(right.x)
    expect(left.w).toBe(4)
  })

  it("resolveOverlaps keeps a locked tile expanding eastward into its neighbor", () => {
    const tiles: LayoutTile[] = [
      { id: "left", type: "term-chat", x: 0, y: 0, w: 8, h: 16, minW: 2, minH: 2 },
      { id: "right", type: "run-history", x: 6, y: 0, w: 6, h: 16, minW: 2, minH: 2 },
    ]
    const next = resolveOverlaps(tiles, 16, new Set(["left"]))
    const left = next.find((t) => t.id === "left")!
    const right = next.find((t) => t.id === "right")!
    expect(left).toMatchObject({ x: 0, w: 8 })
    expect(right.x).toBe(8)
    expect(right.w).toBe(4)
  })

  it("reclaimSpace expands remaining tiles after one is removed", () => {
    const remaining: LayoutTile[] = [
      { id: "a", type: "term-chat", x: 0, y: 0, w: 4, h: 8, minW: 2, minH: 2 },
      { id: "b", type: "run-history", x: 4, y: 0, w: 4, h: 8, minW: 2, minH: 2 },
    ]
    const next = reclaimSpace(remaining, 16)
    const covered = next.reduce((sum, tile) => sum + tile.w * tile.h, 0)
    expect(covered).toBe(COLS * 16)
    expect(next.every((tile) => tile.y + tile.h <= 16)).toBe(true)
  })

  it("reclaimSpace fills the canvas when one tile remains", () => {
    const next = reclaimSpace([
      { id: "a", type: "term-chat", x: 2, y: 2, w: 4, h: 4, minW: 2, minH: 2 },
    ], 12)
    expect(next[0]).toMatchObject({ x: 0, y: 0, w: COLS, h: 12 })
  })

  it("reclaimSpace keeps a resized tile locked while neighbors fill the gap", () => {
    const tiles: LayoutTile[] = [
      { id: "chat", type: "term-chat", x: 0, y: 0, w: 6, h: 16, minW: 2, minH: 2 },
      { id: "threads", type: "thread-nav", x: 9, y: 0, w: 3, h: 16, minW: 2, minH: 4 },
    ]
    const next = reclaimSpace(tiles, 16, new Set(["threads"]))
    const chat = next.find((tile) => tile.id === "chat")!
    const threads = next.find((tile) => tile.id === "threads")!
    expect(threads).toMatchObject({ x: 9, w: 3, h: 16 })
    expect(chat.w).toBeGreaterThanOrEqual(9)
    expect(chat.x + chat.w).toBe(threads.x)
  })
})

describe("edge snap + arrange", () => {
  it("snapToCanvasEdges pulls flush within threshold", () => {
    const left = snapToCanvasEdges({ x: 1, y: 3, w: 4, h: 4 }, 16, 1)
    expect(left).toMatchObject({ rect: { x: 0, y: 3, w: 4, h: 4 }, edgePin: "w" })

    const right = snapToCanvasEdges({ x: 7, y: 2, w: 4, h: 4 }, 16, 1)
    expect(right).toMatchObject({ rect: { x: 8, y: 2, w: 4, h: 4 }, edgePin: "e" })

    const top = snapToCanvasEdges({ x: 3, y: 1, w: 4, h: 4 }, 16, 1)
    expect(top).toMatchObject({ rect: { x: 3, y: 0, w: 4, h: 4 }, edgePin: "n" })

    const bottom = snapToCanvasEdges({ x: 2, y: 11, w: 4, h: 4 }, 16, 1)
    expect(bottom).toMatchObject({ rect: { x: 2, y: 12, w: 4, h: 4 }, edgePin: "s" })
  })

  it("snapToCanvasEdges leaves mid-canvas rects unpinned", () => {
    const mid = snapToCanvasEdges({ x: 3, y: 4, w: 4, h: 4 }, 16, 1)
    expect(mid.edgePin).toBeUndefined()
    expect(mid.rect).toMatchObject({ x: 3, y: 4, w: 4, h: 4 })
  })

  it("applyEdgePin re-glues after viewport row change", () => {
    const tile: LayoutTile = {
      id: "a",
      type: "term-chat",
      x: 2,
      y: 0,
      w: 4,
      h: 8,
      minW: 2,
      minH: 2,
      edgePin: "e",
    }
    const glued = applyEdgePin(tile, 12)
    expect(glued).toMatchObject({ x: 8, y: 0, w: 4, h: 8, edgePin: "e" })
    const shorter = applyEdgePin({ ...glued, h: 6, y: 2, edgePin: "s" }, 10)
    expect(shorter).toMatchObject({ y: 4, h: 6, edgePin: "s" })
  })

  it("arrange leaves intentional gaps — resolveDragLayout without reclaimSpace", () => {
    const tiles: LayoutTile[] = [
      { id: "a", type: "term-chat", x: 0, y: 0, w: 4, h: 8, minW: 2, minH: 2 },
      { id: "b", type: "run-status", x: 8, y: 0, w: 4, h: 8, minW: 2, minH: 2 },
    ]
    const arranged = resolveDragLayout(
      tiles,
      "a",
      { x: 0, y: 0, w: 4, h: 8 },
      { x: 0, y: 0, w: 4, h: 8 },
      16,
    )
    const covered = arranged.reduce((sum, tile) => sum + tile.w * tile.h, 0)
    expect(covered).toBe(4 * 8 + 4 * 8)
    expect(covered).toBeLessThan(COLS * 16)

    const packed = reclaimSpace(arranged, 16)
    const packedCovered = packed.reduce((sum, tile) => sum + tile.w * tile.h, 0)
    expect(packedCovered).toBe(COLS * 16)
  })

  it("reclaimSpace does not grow edge-pinned tiles into gaps", () => {
    const tiles: LayoutTile[] = [
      {
        id: "a",
        type: "term-chat",
        x: 0,
        y: 0,
        w: 4,
        h: 8,
        minW: 2,
        minH: 2,
        edgePin: "w",
      },
      { id: "b", type: "run-status", x: 8, y: 0, w: 4, h: 8, minW: 2, minH: 2 },
    ]
    const next = reclaimSpace(tiles, 16)
    const a = next.find((tile) => tile.id === "a")!
    expect(a).toMatchObject({ x: 0, w: 4, edgePin: "w" })
  })

  it("placeNewTile prefers a horizontal half-split for the second widget", () => {
    const first = placeNewTile([], "a", "term-chat", WIDGET_DEFAULTS["term-chat"], 16)
    const second = placeNewTile(first.tiles, "b", "run-status", WIDGET_DEFAULTS["run-status"], 16)
    const [left, right] = second.tiles
    expect(left!.y).toBe(right!.y)
    expect(left!.h).toBe(right!.h)
    expect(left!.w + right!.w).toBe(COLS)
  })
})

describe("snap / resize grid math", () => {
  it("pixelsToGridRect snaps to column/row units", () => {
    const cw = colWidth(1200)
    const rect = pixelsToGridRect({ left: cw + 8, top: 40, width: cw * 2 + 8, height: 72 }, cw, 1, 1)
    expect(rect.x).toBe(1)
    expect(rect.w).toBeGreaterThanOrEqual(2)
    expect(rect.y).toBeGreaterThanOrEqual(0)
  })

  it("snapDragRect keeps tile within columns", () => {
    const tile: LayoutTile = {
      id: "t",
      type: "run-status",
      x: 10,
      y: 0,
      w: 2,
      h: 3,
      minW: 1,
      minH: 1,
    }
    const cw = colWidth(1200)
    const next = snapDragRect(tile, 9999, 0, cw)
    expect(next.x + next.w).toBeLessThanOrEqual(COLS)
  })

  it("clampRectToGrid prevents overflow past viewport rows", () => {
    const clamped = clampRectToGrid({ x: 0, y: 20, w: 6, h: 8 }, 10, 2, 2)
    expect(clamped.y + clamped.h).toBeLessThanOrEqual(10)
    expect(clamped.x + clamped.w).toBeLessThanOrEqual(COLS)
  })

  it("snapDragRect respects maxRows", () => {
    const tile: LayoutTile = {
      id: "t",
      type: "run-status",
      x: 0,
      y: 8,
      w: 4,
      h: 3,
      minW: 1,
      minH: 1,
    }
    const cw = colWidth(1200)
    const next = snapDragRect(tile, 0, 9999, cw, 12)
    expect(next.y + next.h).toBeLessThanOrEqual(12)
  })

  it("rowsForHeight derives grid capacity from viewport", () => {
    expect(rowsForHeight(40)).toBe(1)
    expect(rowsForHeight(400)).toBeGreaterThan(5)
  })

  it("viewportGridMetrics stretches rows to fill height", () => {
    const metrics = viewportGridMetrics(1200, 400)
    const used = metrics.rows * metrics.rowPx + (metrics.rows - 1) * 8
    expect(used).toBeCloseTo(400, 0)
  })
})

describe("workspace view wire migrate", () => {
  it("preserves tiles through viewToWire and viewFromWire", () => {
    const view = {
      id: "v1",
      name: "Ops",
      tiles: [{
        id: "w1",
        type: "term-chat" as const,
        x: 0,
        y: 0,
        w: 4,
        h: 6,
        minW: 2,
        minH: 2,
        edgePin: "w" as const,
      }],
    }
    const roundtrip = viewFromWire(viewToWire(view))
    expect(roundtrip).toEqual(view)
  })

  it("round-trips edgePin on LayoutItem wire", () => {
    const legacy = {
      id: "default",
      name: "Main",
      widgets: [{ id: "a", type: "term-chat" as const }],
      layouts: {
        lg: [{ i: "a", x: 0, y: 0, w: 6, h: 8, minW: 2, minH: 2, edgePin: "w" as const }],
      },
    }
    const migrated = viewFromWire(legacy)
    expect(migrated.tiles[0]).toMatchObject({ edgePin: "w", x: 0, w: 6 })
    expect(viewToWire(migrated).layouts.lg![0]).toMatchObject({ edgePin: "w" })
  })

  it("migrates legacy widgets + layouts.lg into tiles", () => {
    const legacy = {
      id: "default",
      name: "Main",
      widgets: [{ id: "a", type: "term-chat" as const }],
      layouts: {
        lg: [{ i: "a", x: 2, y: 1, w: 6, h: 8, minW: 2, minH: 2 }],
      },
    }
    const migrated = viewFromWire(legacy)
    expect(migrated.tiles).toEqual([{
      id: "a",
      type: "term-chat",
      x: 2,
      y: 1,
      w: 6,
      h: 8,
      minW: 2,
      minH: 2,
    }])
  })

  it("fills missing layout from WIDGET_DEFAULTS", () => {
    const legacy = {
      id: "default",
      name: "Main",
      widgets: [{ id: "b", type: "run-history" as const }],
      layouts: { lg: [] },
    }
    const migrated = viewFromWire(legacy)
    expect(migrated.tiles[0]).toMatchObject({
      id: "b",
      type: "run-history",
      w: WIDGET_DEFAULTS["run-history"].w,
      h: WIDGET_DEFAULTS["run-history"].h,
    })
  })
})
