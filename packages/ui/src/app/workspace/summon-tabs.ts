/**
 * Summon list navigation — one column, filter modes, digit tile guard.
 * ↑↓ move · ←→ / Tab cycle All → Spaces → Surfaces · 1–9 target blueprint tiles.
 */

import { detectModHint } from "../../lib/keymap"
import { tileHotkeyIndex } from "../../lib/space-layout-inspector-nav"
import type { SummonItem } from "./summon-items"

export type SummonFilterMode = "all" | "spaces" | "surfaces"

/** Tab order — All first, then Spaces, then Surfaces. */
export const SUMMON_FILTER_MODES: readonly SummonFilterMode[] = [
  "all",
  "spaces",
  "surfaces",
]

export const SUMMON_FILTER_LABEL: Record<SummonFilterMode, string> = {
  all: "All",
  spaces: "Spaces",
  surfaces: "Surfaces",
}

/** Destinations (Spaces + presets) before surfaces — stable spatial memory. */
export function orderSummonForNav(items: readonly SummonItem[]): SummonItem[] {
  const go = items.filter((item) => item.kind === "space" || item.kind === "bundle")
  const surface = items.filter((item) => item.kind === "widget")
  return [...go, ...surface]
}

export function filterSummonByMode(
  items: readonly SummonItem[],
  mode: SummonFilterMode,
): SummonItem[] {
  const ordered = orderSummonForNav(items)
  if (mode === "spaces") {
    return ordered.filter((item) => item.kind === "space" || item.kind === "bundle")
  }
  if (mode === "surfaces") {
    return ordered.filter((item) => item.kind === "widget")
  }
  return ordered
}

export type SummonListSection = {
  id: "spaces" | "presets" | "surfaces"
  title: string
  items: SummonItem[]
}

/** Visual sections for the unified list (selection stays flat). */
export function summonListSections(items: readonly SummonItem[]): SummonListSection[] {
  const spaces = items.filter((item) => item.kind === "space")
  const presets = items.filter((item) => item.kind === "bundle")
  const surfaces = items.filter((item) => item.kind === "widget")
  const sections: SummonListSection[] = []
  if (spaces.length > 0) sections.push({ id: "spaces", title: "Spaces", items: spaces })
  if (presets.length > 0) sections.push({ id: "presets", title: "Presets", items: presets })
  if (surfaces.length > 0) {
    sections.push({ id: "surfaces", title: "Surfaces", items: surfaces })
  }
  return sections
}

export function moveSummonListSelection(
  selected: number,
  total: number,
  dir: "up" | "down",
): number {
  if (total <= 0) return 0
  const index = Math.max(0, Math.min(selected, total - 1))
  if (dir === "up") return Math.max(0, index - 1)
  return Math.min(total - 1, index + 1)
}

export function cycleSummonFilter(
  mode: SummonFilterMode,
  dir: "next" | "prev" = "next",
): SummonFilterMode {
  const i = SUMMON_FILTER_MODES.indexOf(mode)
  const at = i < 0 ? 0 : i
  const next =
    dir === "next"
      ? (at + 1) % SUMMON_FILTER_MODES.length
      : (at - 1 + SUMMON_FILTER_MODES.length) % SUMMON_FILTER_MODES.length
  return SUMMON_FILTER_MODES[next]!
}

/**
 * Digit → blueprint pick index while typing in Summon search.
 * Null when modifiers, non-empty query, or out-of-range digit.
 */
export function shouldSummonBlueprintDigit(
  event: {
    key: string
    metaKey: boolean
    ctrlKey: boolean
    altKey: boolean
    shiftKey: boolean
  },
  query: string,
  pickableCount: number,
): number | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null
  if (query.trim() !== "") return null
  return tileHotkeyIndex(event.key, pickableCount)
}

/** ←→ cycle filter only when the search field is empty (else caret moves). */
export function shouldSummonFilterArrow(
  event: {
    key: string
    metaKey: boolean
    ctrlKey: boolean
    altKey: boolean
  },
  query: string,
): "next" | "prev" | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null
  if (query.trim() !== "") return null
  if (event.key === "ArrowRight") return "next"
  if (event.key === "ArrowLeft") return "prev"
  return null
}

/** Action chips on the right (same kbd dialect as keymap). */
export function summonActionKeys(
  item: SummonItem,
  _opts: { onSpace: boolean },
): readonly string[] {
  if (item.kind === "space") {
    // Call Space chords are Mod+1…5 only.
    return item.index >= 1 && item.index <= 5
      ? [detectModHint(), String(item.index)]
      : ["↵"]
  }
  if (item.kind === "bundle") return ["↵"]
  return ["↵"]
}
