/**
 * Keymap sheet registry — searchable two-column shortcut table (Pane | Shell).
 * Source of truth for the ? modal; strip hints stay in bindings.ts.
 * Mod chords use `Mod` — display resolves via detectModHint() (⌘ vs Ctrl).
 */

import { MOD, resolveKeyCaptions } from "./mod-hint"

export type KeymapCategory = "pane" | "workspace" | "global"

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
  // Pane — shared review (Trace + Pipelines)
  {
    id: "review-pane-toggle",
    label: "Tree ↔ Detail",
    keys: ["`"],
    category: "pane",
    context: "Trace · Pipelines",
  },
  {
    id: "review-return-tree",
    label: "Return to Tree",
    keys: ["Esc"],
    category: "pane",
    context: "Detail",
  },
  {
    id: "review-tree-move",
    label: "Move in Tree",
    keys: ["↑", "↓"],
    category: "pane",
    context: "Tree",
  },
  {
    id: "review-tree-fold",
    label: "Fold / unfold tree",
    keys: ["←", "→"],
    category: "pane",
    context: "Tree",
  },
  {
    id: "review-detail-move",
    label: "Move in Detail",
    keys: ["↑", "↓"],
    category: "pane",
    context: "Detail",
  },
  {
    id: "review-detail-fold",
    label: "Fold / unfold detail section",
    keys: ["←", "→"],
    category: "pane",
    context: "Detail",
  },
  {
    id: "review-detail-toggle",
    label: "Toggle detail section",
    keys: ["Space"],
    category: "pane",
    context: "Detail",
  },
  {
    id: "trace-max",
    label: "Maximize / restore",
    keys: ["M"],
    category: "pane",
    context: "Trace · Pipelines",
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

/** When Trace/Pipelines report an active pane, hide the other pane’s exclusive chords. */
export type ActivePaneSurface = "tree" | "detail" | null

export function matchesActivePaneContext(
  item: ShortcutItem,
  surface: ActivePaneSurface,
): boolean {
  if (item.category !== "pane" || surface == null) return true
  const ctx = (item.context ?? "").toLowerCase()
  const detailOnly = /\bdetail\b/.test(ctx)
  const treeOnly = /\btree\b/.test(ctx) && !detailOnly
  if (surface === "detail" && treeOnly) return false
  if (surface === "tree" && detailOnly) return false
  return true
}

export function filterShortcutRegistry(
  items: readonly ShortcutItem[],
  query: string,
  surface: ActivePaneSurface = null,
): ShortcutItem[] {
  const q = query.trim().toLowerCase()
  return items.filter((item) => {
    if (!matchesActivePaneContext(item, surface)) return false
    if (!q) return true
    const keys = resolveKeyCaptions(item.keys).join(" ")
    const hay = `${item.label} ${keys} ${item.context ?? ""} ${item.category}`.toLowerCase()
    return hay.includes(q)
  })
}
