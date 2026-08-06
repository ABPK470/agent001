/**
 * Binding tables — strips and KeymapSheet read from here.
 * Mod chords use `Mod` — display resolves via detectModHint() (⌘ vs Ctrl).
 */

import type { KbdHint, KeymapBinding } from "./types"
import { MOD } from "./mod-hint"

export const SHELL_BINDINGS: readonly KeymapBinding[] = [
  { id: "call-space", layer: "view", keys: [MOD, "1–4"], label: "Call Space" },
  { id: "cycle-view", layer: "view", keys: [MOD, "[", "]"], label: "Prev / next view tab" },
  { id: "tile-focus", layer: "view", keys: [MOD, "⇧", "↑↓←→"], label: "Focus tile" },
  { id: "maximize", layer: "widget", keys: ["M"], label: "Maximize / restore", when: "tile focused" },
  { id: "zen", layer: "widget", keys: ["Z"], label: "Zen on / off", when: "focus-capable tile" },
  { id: "close-tile", layer: "widget", keys: [MOD, "W"], label: "Close tile", when: "tile focused" },
  { id: "summon", layer: "app", keys: [MOD, "K"], label: "Summon" },
  { id: "shell-mode", layer: "app", keys: [MOD, "⌥"], label: "Chat ↔ workspace" },
  { id: "focus-composer", layer: "app", keys: [MOD, "'"], label: "Focus chat input" },
  { id: "keymap", layer: "app", keys: ["?"], label: "Keymap" },
]

export const TRACE_TREE_HINTS: readonly KbdHint[] = [
  { keys: [MOD, "\\"], label: "runs" },
  { keys: ["`"], label: "pane" },
  { keys: ["↵"], label: "detail" },
  { keys: ["↑", "↓"], label: "move" },
  { keys: ["←", "→"], label: "fold" },
  { keys: ["M"], label: "max" },
  { keys: ["Z"], label: "zen" },
]

export const TRACE_SCOPE_DRAWER_BINDING: KeymapBinding = {
  id: "trace-scope-drawer",
  layer: "widget",
  keys: [MOD, "\\"],
  label: "Thread / run drawer",
  when: "Trace focused",
}

export const TRACE_DETAIL_HINTS: readonly KbdHint[] = [
  { keys: ["`"], label: "tree" },
  { keys: ["↑", "↓"], label: "scroll" },
  { keys: ["←", "→"], label: "tabs" },
  { keys: ["Esc"], label: "tree" },
]

export const SUMMON_HINTS: readonly KbdHint[] = [
  { keys: ["↵"], label: "go / peek / focus" },
  { keys: [MOD, "↵"], label: "keep" },
  { keys: ["↑", "↓"], label: "navigate" },
  { keys: ["1–3"], label: "categories" },
  { keys: ["Tab"], label: "cycle" },
  { keys: ["Esc"], label: "dismiss" },
]

export function hintsForTracePane(pane: "tree" | "detail"): readonly KbdHint[] {
  return pane === "tree" ? TRACE_TREE_HINTS : TRACE_DETAIL_HINTS
}
