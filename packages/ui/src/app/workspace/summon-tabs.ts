/**
 * Summon board navigation — two columns, arrow keys only.
 * ↑↓ move inside a column · ←→ jump between Go and Surface.
 */

import { detectModHint } from "../../lib/keymap"
import type { SummonItem } from "./summon-items"

export type SummonColumn = "go" | "surface"

export type SummonColumns = {
  go: SummonItem[]
  surface: SummonItem[]
}

export function partitionSummonColumns(items: readonly SummonItem[]): SummonColumns {
  const go = items.filter((item) => item.kind === "space" || item.kind === "bundle")
  const surface = items.filter((item) => item.kind === "widget")
  return { go, surface }
}

/** Flat selection order: destinations then surfaces (matches column paint). */
export function orderSummonForNav(items: readonly SummonItem[]): SummonItem[] {
  const { go, surface } = partitionSummonColumns(items)
  return [...go, ...surface]
}

export function moveSummonSelection(
  selected: number,
  columns: SummonColumns,
  dir: "up" | "down" | "left" | "right",
): number {
  const goLen = columns.go.length
  const surfaceLen = columns.surface.length
  const total = goLen + surfaceLen
  if (total === 0) return 0

  const index = Math.max(0, Math.min(selected, total - 1))
  const inGo = index < goLen
  const local = inGo ? index : index - goLen

  if (dir === "up") {
    if (local <= 0) return index
    return index - 1
  }
  if (dir === "down") {
    const colLen = inGo ? goLen : surfaceLen
    if (local >= colLen - 1) return index
    return index + 1
  }
  if (dir === "right" && inGo && surfaceLen > 0) {
    return goLen + Math.min(local, surfaceLen - 1)
  }
  if (dir === "left" && !inGo && goLen > 0) {
    return Math.min(local, goLen - 1)
  }
  return index
}

/** Action chips on the right (same kbd dialect as keymap). */
export function summonActionKeys(
  item: SummonItem,
  opts: { onSpace: boolean },
): readonly string[] {
  if (item.kind === "space") {
    return item.index >= 1 ? [detectModHint(), String(item.index)] : ["↵"]
  }
  if (item.kind === "bundle") return ["↵"]
  if (opts.onSpace) return ["↵"]
  return ["↵"]
}
