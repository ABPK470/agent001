/**
 * Top-level application shells — two modes, one product.
 *
 *   chat      — focused conversation (threads, minimal chrome)
 *   workspace — named layouts and product surfaces (ops, full visibility)
 */

import { detectModHint, type ModHint } from "../lib/keymap"

export type AppShellMode = "workspace" | "chat"

export const APP_SHELL_MODES: ReadonlyArray<AppShellMode> = ["chat", "workspace"]

export { detectModHint, type ModHint }

/**
 * Toggle chat ↔ workspace. Same binding in both shells.
 * Mac: ⌘⌥  ·  elsewhere: Ctrl+Alt
 * Fires on Option/Alt keydown while Mod is held.
 */
export function shellModeToggleHint(modKey: ModHint = detectModHint()): string {
  return modKey === "⌘" ? "⌘⌥" : "Ctrl+Alt"
}

export { isShellModeToggleEvent, isOpenWidgetCatalogEvent } from "../lib/keymap"

/**
 * Open Spotlight Summon (peek a Space / widget / bundle).
 * Mac: ⌘K  ·  elsewhere: Ctrl+K
 */
export function openWidgetCatalogHint(modKey: ModHint = detectModHint()): string {
  return modKey === "⌘" ? "⌘K" : "Ctrl+K"
}

/** Which chat surface to mount inside the chat shell. */
export type ChatVariant = "thread" | "legacy"

export function resolveChatVariant(): ChatVariant {
  return import.meta.env.VITE_HOME_SHELL === "legacy" ? "legacy" : "thread"
}
