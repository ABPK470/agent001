/**
 * Always-on shell chrome chords — Summon + chat↔workspace toggle.
 * Detected at the composition root before the operator session gate.
 */

/**
 * Toggle chat ↔ workspace. Same binding in both shells.
 * Mac: ⌘⌥  ·  elsewhere: Ctrl+Alt
 * Fires on Option/Alt keydown while Mod is held.
 */
export function isShellModeToggleEvent(event: KeyboardEvent): boolean {
  if (event.shiftKey) return false
  if (!(event.metaKey || event.ctrlKey)) return false
  return event.code === "AltLeft" || event.code === "AltRight" || event.key === "Alt"
}

/**
 * Open Spotlight Summon (peek a Space / widget / bundle).
 * Mac: ⌘K  ·  elsewhere: Ctrl+K
 */
export function isOpenWidgetCatalogEvent(event: KeyboardEvent): boolean {
  if (event.altKey || event.shiftKey) return false
  if (!(event.metaKey || event.ctrlKey)) return false
  return event.key.toLowerCase() === "k"
}
