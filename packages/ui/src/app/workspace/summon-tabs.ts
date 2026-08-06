/**
 * Summon category tabs — same interaction model as the keymap sheet (1–3, Tab).
 */

import type { SummonItem } from "./summon-items"

export type SummonTab = "all" | "go" | "surface"

export const SUMMON_TABS: readonly { id: SummonTab; num: string; label: string }[] = [
  { id: "all", num: "1", label: "All" },
  { id: "go", num: "2", label: "Go" },
  { id: "surface", num: "3", label: "Surface" },
]

export function matchesSummonTab(item: SummonItem, tab: SummonTab): boolean {
  if (tab === "all") return true
  if (tab === "go") return item.kind === "space" || item.kind === "bundle"
  return item.kind === "widget"
}

export function filterSummonByTab(
  items: readonly SummonItem[],
  tab: SummonTab,
): SummonItem[] {
  return items.filter((item) => matchesSummonTab(item, tab))
}

export function nextSummonTab(current: SummonTab, direction: 1 | -1): SummonTab {
  const order: SummonTab[] = ["all", "go", "surface"]
  const i = order.indexOf(current)
  return order[(i + direction + order.length) % order.length]!
}

export function summonTabFromDigit(key: string): SummonTab | null {
  if (key === "1") return "all"
  if (key === "2") return "go"
  if (key === "3") return "surface"
  return null
}

/** Flat ↑↓ order: destinations (spaces → bundles) then surfaces. */
export function orderSummonForNav(items: readonly SummonItem[]): SummonItem[] {
  const go = items.filter((item) => item.kind === "space" || item.kind === "bundle")
  const surfaces = items.filter((item) => item.kind === "widget")
  return [...go, ...surfaces]
}

/** Action chips on the right (same kbd dialect as keymap). */
export function summonActionKeys(
  item: SummonItem,
  opts: { onSpace: boolean },
): readonly string[] {
  if (item.kind === "space") {
    return item.index >= 1 ? ["⌘", String(item.index)] : ["↵"]
  }
  if (item.kind === "bundle") return ["↵"]
  if (opts.onSpace) return ["↵"]
  return ["↵"]
}
