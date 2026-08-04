/**
 * Top-level application shells — two modes, one product.
 *
 *   chat      — focused conversation (threads, minimal chrome)
 *   workspace — named layouts and product surfaces (ops, full visibility)
 */

export type AppShellMode = "workspace" | "chat"

export const APP_SHELL_MODES: ReadonlyArray<AppShellMode> = ["chat", "workspace"]

/**
 * Toggle chat ↔ workspace. Same binding in both shells.
 * Mac: ⌘⌥  ·  elsewhere: Ctrl+Alt
 * Fires on Option/Alt keydown while Mod is held.
 */
export function shellModeToggleHint(modKey: "⌘" | "Ctrl" = detectModHint()): string {
  return modKey === "⌘" ? "⌘⌥" : "Ctrl+Alt"
}

export function detectModHint(): "⌘" | "Ctrl" {
  if (typeof navigator === "undefined") return "Ctrl"
  return /Mac|iPhone|iPad/i.test(navigator.platform) ? "⌘" : "Ctrl"
}

export function isShellModeToggleEvent(event: KeyboardEvent): boolean {
  if (event.shiftKey) return false
  if (!(event.metaKey || event.ctrlKey)) return false
  return event.code === "AltLeft" || event.code === "AltRight" || event.key === "Alt"
}

/**
 * Open the widget catalog (Add to layout). Workspace shell only.
 * Mac: ⌘K  ·  elsewhere: Ctrl+K
 */
export function openWidgetCatalogHint(modKey: "⌘" | "Ctrl" = detectModHint()): string {
  return modKey === "⌘" ? "⌘K" : "Ctrl+K"
}

export function isOpenWidgetCatalogEvent(event: KeyboardEvent): boolean {
  if (event.altKey || event.shiftKey) return false
  if (!(event.metaKey || event.ctrlKey)) return false
  return event.key.toLowerCase() === "k"
}

/** Which chat surface to mount inside the chat shell. */
export type ChatVariant = "thread" | "legacy"

export function resolveChatVariant(): ChatVariant {
  return import.meta.env.VITE_HOME_SHELL === "legacy" ? "legacy" : "thread"
}
