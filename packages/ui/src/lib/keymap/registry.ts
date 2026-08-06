/**
 * Keymap sheet registry — searchable, category-filtered shortcut table.
 * Source of truth for the ? modal; strip hints stay in bindings.ts.
 * Mod chords use `Mod` — display resolves via detectModHint() (⌘ vs Ctrl).
 */

import { MOD, resolveKeyCaptions } from "./mod-hint"

export type KeymapCategory = "pane" | "workspace" | "global"

export type KeymapTab = "all" | "pane" | "shell"

export type ShortcutItem = {
  id: string
  label: string
  keys: readonly string[]
  category: KeymapCategory
  /** Optional surface this binding belongs to (e.g. Trace). */
  context?: string
}

/** Full operator registry — labels are sheet-facing (not strip shorthand). */
export const SHORTCUT_REGISTRY: readonly ShortcutItem[] = [
  // Pane — Trace
  {
    id: "trace-pane-toggle",
    label: "Tree ↔ Detail",
    keys: ["`"],
    category: "pane",
    context: "Trace",
  },
  {
    id: "trace-jump-detail",
    label: "Jump to Detail",
    keys: ["↵"],
    category: "pane",
    context: "Trace · Tree",
  },
  {
    id: "trace-return-tree",
    label: "Return to Tree",
    keys: ["Esc"],
    category: "pane",
    context: "Trace · Detail",
  },
  {
    id: "trace-tree-move",
    label: "Move in Tree",
    keys: ["↑", "↓"],
    category: "pane",
    context: "Trace · Tree",
  },
  {
    id: "trace-tree-fold",
    label: "Fold / unfold",
    keys: ["←", "→"],
    category: "pane",
    context: "Trace · Tree",
  },
  {
    id: "trace-detail-scroll",
    label: "Scroll Detail",
    keys: ["↑", "↓"],
    category: "pane",
    context: "Trace · Detail",
  },
  {
    id: "trace-detail-tabs",
    label: "Cycle Detail tabs",
    keys: ["←", "→"],
    category: "pane",
    context: "Trace · Detail",
  },
  {
    id: "trace-max",
    label: "Maximize / restore",
    keys: ["M"],
    category: "pane",
    context: "Trace",
  },
  {
    id: "trace-zen",
    label: "Zen on / off",
    keys: ["Z"],
    category: "pane",
    context: "Trace",
  },
  {
    id: "trace-scope-drawer",
    label: "Thread / run drawer",
    keys: [MOD, "\\"],
    category: "pane",
    context: "Trace",
  },

  // Workspace
  {
    id: "call-space",
    label: "Call Space",
    keys: [MOD, "1–4"],
    category: "workspace",
  },
  {
    id: "cycle-view",
    label: "Prev / next view tab",
    keys: [MOD, "[", "]"],
    category: "workspace",
  },
  {
    id: "tile-focus",
    label: "Focus neighboring tile",
    keys: [MOD, "⇧", "↑↓←→"],
    category: "workspace",
  },
  {
    id: "maximize",
    label: "Maximize / restore tile",
    keys: ["M"],
    category: "workspace",
  },
  {
    id: "zen",
    label: "Zen on / off",
    keys: ["Z"],
    category: "workspace",
  },
  {
    id: "close-tile",
    label: "Close focused tile",
    keys: [MOD, "W"],
    category: "workspace",
  },
  {
    id: "summon",
    label: "Summon",
    keys: [MOD, "K"],
    category: "workspace",
  },

  // Global shell
  {
    id: "shell-mode",
    label: "Chat ↔ workspace",
    keys: [MOD, "⌥"],
    category: "global",
  },
  {
    id: "focus-composer",
    label: "Focus chat input",
    keys: [MOD, "'"],
    category: "global",
  },
  {
    id: "keymap",
    label: "Keymap",
    keys: ["?"],
    category: "global",
  },
]

export const KEYMAP_TABS: readonly { id: KeymapTab; num: string; label: string }[] = [
  { id: "all", num: "1", label: "All" },
  { id: "pane", num: "2", label: "Pane" },
  { id: "shell", num: "3", label: "Shell" },
]

export function matchesKeymapTab(item: ShortcutItem, tab: KeymapTab): boolean {
  if (tab === "all") return true
  if (tab === "pane") return item.category === "pane"
  return item.category === "workspace" || item.category === "global"
}

export function filterShortcutRegistry(
  items: readonly ShortcutItem[],
  query: string,
  tab: KeymapTab,
): ShortcutItem[] {
  const q = query.trim().toLowerCase()
  return items.filter((item) => {
    if (!matchesKeymapTab(item, tab)) return false
    if (!q) return true
    const keys = resolveKeyCaptions(item.keys).join(" ")
    const hay = `${item.label} ${keys} ${item.context ?? ""} ${item.category}`.toLowerCase()
    return hay.includes(q)
  })
}

export function nextKeymapTab(current: KeymapTab, direction: 1 | -1): KeymapTab {
  const order: KeymapTab[] = ["all", "pane", "shell"]
  const i = order.indexOf(current)
  const next = (i + direction + order.length) % order.length
  return order[next]!
}

export function keymapTabFromDigit(key: string): KeymapTab | null {
  if (key === "1") return "all"
  if (key === "2") return "pane"
  if (key === "3") return "shell"
  return null
}
