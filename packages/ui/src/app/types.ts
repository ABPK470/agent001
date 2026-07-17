/**
 * Top-level application shells — two modes, one product.
 *
 *   chat      — focused conversation (threads, minimal chrome)
 *   workspace — widget canvas (dashboards, ops, full visibility)
 */

export type AppShellMode = "workspace" | "chat"

export const APP_SHELL_MODES: ReadonlyArray<AppShellMode> = ["chat", "workspace"]

/** Which chat surface to mount inside the chat shell. */
export type ChatVariant = "thread" | "legacy"

export function resolveChatVariant(): ChatVariant {
  return import.meta.env.VITE_HOME_SHELL === "legacy" ? "legacy" : "thread"
}
