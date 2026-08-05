/**
 * Keymap vocabulary — one source for resolvers, strips, and the ? sheet.
 */

export type KeymapLayer =
  | "modal"
  | "input"
  | "pane"
  | "widget"
  | "view"
  | "app"

export type KbdHint = {
  keys: string[]
  label: string
}

export type KeymapBinding = {
  id: string
  layer: KeymapLayer
  keys: string[]
  label: string
  when?: string
}
