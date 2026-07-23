/**
 * Top-level application shells — two modes, one product.
 *
 *   chat      — focused conversation (threads, minimal chrome)
 *   workspace — widget canvas (dashboards, ops, full visibility)
 */

export type AppShellMode = "workspace" | "chat"

export const APP_SHELL_MODES: ReadonlyArray<AppShellMode> = ["chat", "workspace"]

/**
 * Toggle chat ↔ workspace. Same binding in both shells.
 * Mod = ⌘ on macOS, Ctrl elsewhere.
 */
export const SHELL_MODE_TOGGLE_CODE = "Backslash" as const

export function shellModeToggleHint(modKey: "⌘" | "Ctrl" = detectModHint()): string {
  return `${modKey}\\`
}

function detectModHint(): "⌘" | "Ctrl" {
  if (typeof navigator === "undefined") return "Ctrl"
  return /Mac|iPhone|iPad/i.test(navigator.platform) ? "⌘" : "Ctrl"
}

export function isShellModeToggleEvent(event: KeyboardEvent): boolean {
  if (event.code !== SHELL_MODE_TOGGLE_CODE) return false
  if (event.altKey || event.shiftKey) return false
  return event.metaKey || event.ctrlKey
}

/** Which chat surface to mount inside the chat shell. */
export type ChatVariant = "thread" | "legacy"

export function resolveChatVariant(): ChatVariant {
  return import.meta.env.VITE_HOME_SHELL === "legacy" ? "legacy" : "thread"
}
