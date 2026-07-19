import { describe, expect, it } from "vitest"
import { COLS, type LayoutTile } from "./grid-math"
import {
  canvasBounds,
  coversCanvas,
  dropZoneFromPoint,
  dropZoneForDrag,
  findDividerForLeafEdge,
  layoutLeaves,
  leafNode,
  projectTiles,
  ratioFromDividerDelta,
  removeLeaf,
  reparentLeaf,
  setSplitRatio,
  splitLargestLeaf,
  splitLeaf,
  swapLeaves,
  treeFromRects,
  type SplitNode,
} from "./split-tree"

function tile(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
): LayoutTile {
  return {
    id,
    type: "term-chat",
    x,
    y,
    w,
    h,
    minW: 2,
    minH: 2,
  }
}

describe("split-tree", () => {
  it("two-pane vertical split covers the canvas", () => {
    const tree: SplitNode = {
      kind: "split",
      dir: "v",
      ratio: 0.5,
      a: leafNode("a"),
      b: leafNode("b"),
    }
    const leaves = layoutLeaves(tree, canvasBounds(COLS, 12))
    expect(coversCanvas(leaves, COLS, 12)).toBe(true)
    expect(leaves).toHaveLength(2)
  })

  it("two-pane horizontal split covers the canvas", () => {
    const tree: SplitNode = {
      kind: "split",
      dir: "h",
      ratio: 0.5,
      a: leafNode("a"),
      b: leafNode("b"),
    }
    expect(coversCanvas(layoutLeaves(tree, canvasBounds(COLS, 10)), COLS, 10)).toBe(true)
  })

  it("three-pane L-topology has no holes after rebuild", () => {
    // Holey legacy: TL, BL, BR — empty TR (the screenshot failure mode).
    const holey = [
      tile("event", 0, 0, 6, 6),
      tile("chat", 0, 6, 6, 6),
      tile("registry", 6, 6, 6, 6),
    ]
    const tree = treeFromRects(holey, COLS, 12)
    expect(tree).not.toBeNull()
    const leaves = layoutLeaves(tree!, canvasBounds(COLS, 12))
    expect(coversCanvas(leaves, COLS, 12)).toBe(true)
    expect(leaves.map((l) => l.tileId).sort()).toEqual(["chat", "event", "registry"])
  })

  it("guillotine partition preserves a clean 2x2 when full", () => {
    const packed = [
      tile("tl", 0, 0, 6, 6),
      tile("tr", 6, 0, 6, 6),
      tile("bl", 0, 6, 6, 6),
      tile("br", 6, 6, 6, 6),
    ]
    const tree = treeFromRects(packed, COLS, 12)
    expect(coversCanvas(layoutLeaves(tree!, canvasBounds(COLS, 12)), COLS, 12)).toBe(true)
  })

  it("divider resize changes both sides", () => {
    const tree: SplitNode = {
      kind: "split",
      dir: "v",
      ratio: 0.5,
      a: leafNode("a"),
      b: leafNode("b"),
    }
    const hit = findDividerForLeafEdge(tree, "a", "e", COLS, 12)
    expect(hit).not.toBeNull()
    const nextRatio = ratioFromDividerDelta(tree, hit!.path, -2, COLS, 12)
    const next = setSplitRatio(tree, hit!.path, nextRatio)
    const leaves = layoutLeaves(next, canvasBounds(COLS, 12))
    const a = leaves.find((l) => l.tileId === "a")!.rect
    const b = leaves.find((l) => l.tileId === "b")!.rect
    expect(a.w + b.w).toBe(COLS)
    expect(a.w).toBeLessThan(6)
    expect(b.w).toBeGreaterThan(6)
  })

  it("reparentLeaf keeps full coverage", () => {
    let tree: SplitNode = {
      kind: "split",
      dir: "v",
      ratio: 0.5,
      a: leafNode("a"),
      b: {
        kind: "split",
        dir: "h",
        ratio: 0.5,
        a: leafNode("b"),
        b: leafNode("c"),
      },
    }
    tree = reparentLeaf(tree, "c", "a", "s")!
    const leaves = layoutLeaves(tree, canvasBounds(COLS, 12))
    expect(coversCanvas(leaves, COLS, 12)).toBe(true)
    expect(leaves).toHaveLength(3)
  })

  it("removeLeaf expands the sibling", () => {
    const tree: SplitNode = {
      kind: "split",
      dir: "v",
      ratio: 0.5,
      a: leafNode("a"),
      b: leafNode("b"),
    }
    const next = removeLeaf(tree, "b")
    expect(next).toEqual(leafNode("a"))
    const leaves = layoutLeaves(next, canvasBounds(COLS, 8))
    expect(leaves[0]!.rect).toMatchObject({ x: 0, y: 0, w: COLS, h: 8 })
  })

  it("splitLargestLeaf adds a pane without holes", () => {
    const tree = splitLargestLeaf(leafNode("a"), "b", COLS, 10)
    expect(coversCanvas(layoutLeaves(tree, canvasBounds(COLS, 10)), COLS, 10)).toBe(true)
    const three = splitLargestLeaf(tree, "c", COLS, 10)
    expect(coversCanvas(layoutLeaves(three, canvasBounds(COLS, 10)), COLS, 10)).toBe(true)
  })

  it("splitLeaf places new id on the requested zone", () => {
    const tree = splitLeaf(leafNode("a"), "a", "b", "e")!
    const leaves = layoutLeaves(tree, canvasBounds(COLS, 8))
    const a = leaves.find((l) => l.tileId === "a")!.rect
    const b = leaves.find((l) => l.tileId === "b")!.rect
    expect(a.x).toBe(0)
    expect(b.x).toBe(a.w)
  })

  it("dropZoneFromPoint picks nearest edge", () => {
    expect(dropZoneFromPoint(10, 50, 100, 100)).toBe("w")
    expect(dropZoneFromPoint(90, 50, 100, 100)).toBe("e")
    expect(dropZoneFromPoint(50, 10, 100, 100)).toBe("n")
    expect(dropZoneFromPoint(50, 90, 100, 100)).toBe("s")
  })

  it("dropZoneForDrag: center swaps, edge bands dock", () => {
    const bridge = { x: 6, y: 0, w: 6, h: 6 }
    const chat = { x: 6, y: 6, w: 6, h: 6 }
    // Center of Bridge (vertical approach from Chat below) → leaf-id swap.
    expect(dropZoneForDrag(50, 50, 100, 100, bridge, chat)).toBe("swap")
    expect(dropZoneForDrag(50, 90, 100, 100, bridge, chat)).toBe("swap")
    // Side band still docks.
    expect(dropZoneForDrag(8, 50, 100, 100, bridge, chat)).toBe("w")
    expect(dropZoneForDrag(95, 50, 100, 100, bridge, chat)).toBe("e")
    // Horizontal approach: center swaps; north/south bands dock.
    const left = { x: 0, y: 0, w: 6, h: 12 }
    const right = { x: 6, y: 0, w: 6, h: 12 }
    expect(dropZoneForDrag(50, 50, 100, 100, right, left)).toBe("swap")
    expect(dropZoneForDrag(50, 8, 100, 100, right, left)).toBe("n")
  })

  it("swapLeaves exchanges Chat and Threads slots; Run History stays put", () => {
    // Home-like: Threads | (Run History / Chat)
    const tree: SplitNode = {
      kind: "split",
      dir: "v",
      ratio: 0.35,
      a: leafNode("threads"),
      b: {
        kind: "split",
        dir: "h",
        ratio: 0.4,
        a: leafNode("run-history"),
        b: leafNode("chat"),
      },
    }
    const rows = 12
    const before = layoutLeaves(tree, canvasBounds(COLS, rows))
    const threadsBefore = before.find((l) => l.tileId === "threads")!.rect
    const chatBefore = before.find((l) => l.tileId === "chat")!.rect
    const runBefore = before.find((l) => l.tileId === "run-history")!.rect

    const swapped = swapLeaves(tree, "chat", "threads")!
    const after = layoutLeaves(swapped, canvasBounds(COLS, rows))
    const threadsAfter = after.find((l) => l.tileId === "threads")!.rect
    const chatAfter = after.find((l) => l.tileId === "chat")!.rect
    const runAfter = after.find((l) => l.tileId === "run-history")!.rect

    expect(chatAfter).toEqual(threadsBefore)
    expect(threadsAfter).toEqual(chatBefore)
    expect(runAfter).toEqual(runBefore)
    expect(coversCanvas(after, COLS, rows)).toBe(true)
  })

  it("edge dock still splits when Chat is reparented onto Threads west", () => {
    const tree: SplitNode = {
      kind: "split",
      dir: "v",
      ratio: 0.35,
      a: leafNode("threads"),
      b: {
        kind: "split",
        dir: "h",
        ratio: 0.4,
        a: leafNode("run-history"),
        b: leafNode("chat"),
      },
    }
    const rows = 12
    const before = layoutLeaves(tree, canvasBounds(COLS, rows))
    const threadsBefore = before.find((l) => l.tileId === "threads")!.rect
    const runBefore = before.find((l) => l.tileId === "run-history")!.rect

    const docked = reparentLeaf(tree, "chat", "threads", "w")!
    const after = layoutLeaves(docked, canvasBounds(COLS, rows))
    const chat = after.find((l) => l.tileId === "chat")!.rect
    const threads = after.find((l) => l.tileId === "threads")!.rect
    const run = after.find((l) => l.tileId === "run-history")!.rect

    // Chat and Threads share the former Threads column; Run History takes full right height.
    expect(chat.y).toBe(0)
    expect(threads.y).toBe(0)
    expect(chat.h).toBe(rows)
    expect(threads.h).toBe(rows)
    expect(chat.w + threads.w).toBeCloseTo(threadsBefore.w, 5)
    expect(run.h).toBe(rows)
    expect(run.h).toBeGreaterThan(runBefore.h)
    expect(coversCanvas(after, COLS, rows)).toBe(true)
  })

  it("swapLeaves exchanges equal peer rects", () => {
    const tree: SplitNode = {
      kind: "split",
      dir: "v",
      ratio: 0.5,
      a: leafNode("a"),
      b: leafNode("b"),
    }
    const rows = 10
    const before = layoutLeaves(tree, canvasBounds(COLS, rows))
    const a0 = before.find((l) => l.tileId === "a")!.rect
    const b0 = before.find((l) => l.tileId === "b")!.rect
    const next = swapLeaves(tree, "a", "b")!
    const after = layoutLeaves(next, canvasBounds(COLS, rows))
    expect(after.find((l) => l.tileId === "a")!.rect).toEqual(b0)
    expect(after.find((l) => l.tileId === "b")!.rect).toEqual(a0)
  })

  it("projectTiles writes geometry onto metadata", () => {
    const tree: SplitNode = {
      kind: "split",
      dir: "h",
      ratio: 0.5,
      a: leafNode("a"),
      b: leafNode("b"),
    }
    const tiles = [tile("a", 0, 0, 1, 1), tile("b", 0, 0, 1, 1)]
    const projected = projectTiles(tree, tiles, COLS, 10)
    expect(projected[0]!.h + projected[1]!.h).toBe(10)
    expect(projected.every((t) => t.w === COLS)).toBe(true)
  })

  it("findDividerForLeafEdge finds nested horizontal divider", () => {
    const tree: SplitNode = {
      kind: "split",
      dir: "v",
      ratio: 0.5,
      a: leafNode("a"),
      b: {
        kind: "split",
        dir: "h",
        ratio: 0.5,
        a: leafNode("b"),
        b: leafNode("c"),
      },
    }
    const hit = findDividerForLeafEdge(tree, "b", "s", COLS, 12)
    expect(hit).toMatchObject({ dir: "h" })
    expect(hit!.path.length).toBeGreaterThan(0)
  })
})
