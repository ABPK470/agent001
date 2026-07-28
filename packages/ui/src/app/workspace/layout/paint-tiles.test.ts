import { describe, expect, it } from "vitest"
import type { LayoutTile } from "../../../lib/grid-math.js"
import { COLS } from "../../../lib/grid-math.js"
import { paintTilesForCanvas } from "./paint-tiles.js"

function tile(partial: Partial<LayoutTile> & Pick<LayoutTile, "id" | "type">): LayoutTile {
  return {
    x: 0,
    y: 0,
    w: 6,
    h: 12,
    minW: 2,
    minH: 4,
    ...partial,
  }
}

describe("paintTilesForCanvas", () => {
  const projected = [
    tile({ id: "a", type: "term-chat", x: 0, y: 0, w: 6, h: 20 }),
    tile({ id: "b", type: "operation-log", x: 6, y: 0, w: 6, h: 20 }),
    tile({ id: "c", type: "debug-inspector", x: 0, y: 20, w: 12, h: 10 }),
  ]

  it("keeps every projected tile when no solo maximize", () => {
    const painted = paintTilesForCanvas(projected, null, 40)
    expect(painted.map((p) => p.tile.id)).toEqual(["a", "b", "c"])
    expect(painted.every((p) => !p.solo && !p.soloHidden)).toBe(true)
    expect(painted[1]!.display).toEqual(projected[1])
  })

  it("keeps all tile ids under solo maximize (no filter unmount)", () => {
    const painted = paintTilesForCanvas(projected, "b", 40)
    expect(painted.map((p) => p.tile.id)).toEqual(["a", "b", "c"])
    expect(painted).toHaveLength(projected.length)
  })

  it("gives the solo tile full-canvas display and hides siblings", () => {
    const painted = paintTilesForCanvas(projected, "b", 40)
    const solo = painted.find((p) => p.tile.id === "b")!
    const hidden = painted.filter((p) => p.tile.id !== "b")

    expect(solo.solo).toBe(true)
    expect(solo.soloHidden).toBe(false)
    expect(solo.display).toMatchObject({ x: 0, y: 0, w: COLS, h: 40 })

    for (const p of hidden) {
      expect(p.solo).toBe(false)
      expect(p.soloHidden).toBe(true)
      expect(p.display.x).toBe(projected.find((t) => t.id === p.tile.id)!.x)
      expect(p.display.y).toBe(projected.find((t) => t.id === p.tile.id)!.y)
    }
  })

  it("preserves order so React keys stay stable across maximize/restore", () => {
    const maximized = paintTilesForCanvas(projected, "a", 30)
    const restored = paintTilesForCanvas(projected, null, 30)
    expect(maximized.map((p) => p.tile.id)).toEqual(restored.map((p) => p.tile.id))
  })
})
