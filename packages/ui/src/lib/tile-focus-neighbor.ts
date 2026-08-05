/**
 * Geometric neighbor for keyboard tile focus (not layout reparent).
 */

import type { LayoutTile } from "./grid-math"

export type FocusArrowKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"

export function neighborTileForFocus(
  tiles: readonly LayoutTile[],
  focusedId: string,
  key: FocusArrowKey,
): string | null {
  const focused = tiles.find((tile) => tile.id === focusedId)
  if (!focused) return null
  const candidates = tiles.filter((tile) => tile.id !== focused.id)
  if (candidates.length === 0) return null

  if (key === "ArrowLeft") {
    const hit = candidates
      .filter(
        (tile) =>
          tile.x + tile.w <= focused.x &&
          Math.min(focused.y + focused.h, tile.y + tile.h) - Math.max(focused.y, tile.y) > 0,
      )
      .sort((a, b) => b.x + b.w - (a.x + a.w))[0]
    return hit?.id ?? null
  }
  if (key === "ArrowRight") {
    const hit = candidates
      .filter(
        (tile) =>
          tile.x >= focused.x + focused.w &&
          Math.min(focused.y + focused.h, tile.y + tile.h) - Math.max(focused.y, tile.y) > 0,
      )
      .sort((a, b) => a.x - b.x)[0]
    return hit?.id ?? null
  }
  if (key === "ArrowUp") {
    const hit = candidates
      .filter(
        (tile) =>
          tile.y + tile.h <= focused.y &&
          Math.min(focused.x + focused.w, tile.x + tile.w) - Math.max(focused.x, tile.x) > 0,
      )
      .sort((a, b) => b.y + b.h - (a.y + a.h))[0]
    return hit?.id ?? null
  }
  const hit = candidates
    .filter(
      (tile) =>
        tile.y >= focused.y + focused.h &&
        Math.min(focused.x + focused.w, tile.x + tile.w) - Math.max(focused.x, tile.x) > 0,
    )
    .sort((a, b) => a.y - b.y)[0]
  return hit?.id ?? null
}
