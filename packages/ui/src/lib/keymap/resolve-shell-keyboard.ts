/**
 * Layer 1 shell chords — maximize, zen, close, Call Space, view tabs, tile focus.
 */

export type ShellKeyboardAction =
  | { type: "toggle-maximize" }
  | { type: "close-tile" }
  | { type: "call-space"; index: number }
  | { type: "cycle-view"; direction: -1 | 1 }
  | { type: "focus-tile-neighbor"; key: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" }
  | { type: "open-keymap" }
  | { type: "focus-composer" }
  | { type: "none" }

export type ShellKeyboardContext = {
  /** Focused tile exists in the active Space. */
  hasFocusedTile: boolean
}

/** Z stays on the widget zen hook (one owner). Shell owns M / close / Spaces / tabs / tile focus. */
export function resolveShellKeyboardAction(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  ctx: ShellKeyboardContext,
): ShellKeyboardAction {
  const mod = event.metaKey || event.ctrlKey
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key

  // `?` is Shift+/ on most layouts — allow shift for this chord only.
  if (key === "?" && !mod && !event.altKey) {
    return { type: "open-keymap" }
  }

  // ⌘/' or Ctrl+' — focus chat composer (and request chat shell).
  if (mod && !event.altKey && !event.shiftKey && (key === "'" || key === '"')) {
    return { type: "focus-composer" }
  }

  if (mod && !event.altKey && !event.shiftKey && /^[1-4]$/.test(key)) {
    return { type: "call-space", index: Number(key) }
  }

  // ⌘/Ctrl+[ / ] — prev / next toolbar view (Spaces + DIY). Avoids browser Ctrl+Tab.
  if (mod && !event.altKey && !event.shiftKey && (key === "[" || key === "]")) {
    return { type: "cycle-view", direction: key === "]" ? 1 : -1 }
  }

  // ⌘⇧+arrows — tile focus. Must NOT use ⌘⌥: that chord alone toggles chat↔workspace
  // on Alt keydown, so ⌘⌥+arrow is unreachable.
  if (mod && event.shiftKey && !event.altKey) {
    if (
      event.key === "ArrowUp" ||
      event.key === "ArrowDown" ||
      event.key === "ArrowLeft" ||
      event.key === "ArrowRight"
    ) {
      return { type: "focus-tile-neighbor", key: event.key }
    }
  }

  if (!ctx.hasFocusedTile) return { type: "none" }

  if (mod && !event.altKey && !event.shiftKey && key === "w") {
    return { type: "close-tile" }
  }

  if (!mod && !event.altKey && !event.shiftKey && key === "m") {
    return { type: "toggle-maximize" }
  }

  return { type: "none" }
}
