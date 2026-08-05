/**
 * Binding tables — strips and KeymapSheet read from here.
 */

import type { KbdHint, KeymapBinding } from "./types"

export const SHELL_BINDINGS: readonly KeymapBinding[] = [
  { id: "call-space", layer: "view", keys: ["⌘/Ctrl", "1–4"], label: "Call Space" },
  { id: "tile-focus", layer: "view", keys: ["⌘/Ctrl", "⌥", "↑↓←→"], label: "Focus tile" },
  { id: "maximize", layer: "widget", keys: ["M"], label: "Maximize / restore", when: "tile focused" },
  { id: "zen", layer: "widget", keys: ["Z"], label: "Zen on / off", when: "focus-capable tile" },
  { id: "close-tile", layer: "widget", keys: ["⌘/Ctrl", "W"], label: "Close tile", when: "tile focused" },
  { id: "summon", layer: "app", keys: ["⌘/Ctrl", "K"], label: "Summon" },
  { id: "shell-mode", layer: "app", keys: ["⌘/Ctrl", "⌥"], label: "Chat ↔ workspace" },
  { id: "focus-composer", layer: "app", keys: ["⌘/Ctrl", "'"], label: "Focus chat input" },
  { id: "keymap", layer: "app", keys: ["?"], label: "Keymap" },
]

export const TRACE_TREE_HINTS: readonly KbdHint[] = [
  { keys: ["↵"], label: "detail" },
  { keys: ["↑", "↓"], label: "move" },
  { keys: ["←", "→"], label: "fold" },
  { keys: ["M"], label: "max" },
  { keys: ["Z"], label: "zen" },
]

export const TRACE_DETAIL_HINTS: readonly KbdHint[] = [
  { keys: ["`"], label: "tree" },
  { keys: ["↑", "↓"], label: "scroll" },
  { keys: ["←", "→"], label: "tabs" },
  { keys: ["Esc"], label: "tree" },
]

export const SUMMON_HINTS: readonly KbdHint[] = [
  { keys: ["↵"], label: "peek" },
  { keys: ["⌘/Ctrl", "↵"], label: "keep in Space" },
  { keys: ["↑", "↓"], label: "navigate" },
  { keys: ["Esc"], label: "dismiss" },
]

export function hintsForTracePane(pane: "tree" | "detail"): readonly KbdHint[] {
  return pane === "tree" ? TRACE_TREE_HINTS : TRACE_DETAIL_HINTS
}
