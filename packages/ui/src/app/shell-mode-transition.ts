/** Chat ↔ workspace — workspace unfolds over a still chat; no layout jump. */

export const SHELL_MODE_TO_WORKSPACE_MS = 240
export const SHELL_MODE_TO_CHAT_MS = 180

export function prefersReducedShellMotion(): boolean {
  if (typeof window === "undefined") return false
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

export function shellModeTransitionMs(to: "chat" | "workspace"): number {
  if (prefersReducedShellMotion()) return 0
  return to === "workspace" ? SHELL_MODE_TO_WORKSPACE_MS : SHELL_MODE_TO_CHAT_MS
}
