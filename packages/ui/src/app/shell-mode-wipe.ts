/**
 * Chat ↔ workspace — persistent horizontal track (220ms).
 * Workspace left, chat right. One transform per toggle; shells stay mounted.
 */

import type { AppShellMode } from "./types"

export const SHELL_WIPE_MS = 220

export const SHELL_WIPE_EASE = "cubic-bezier(0.16, 1, 0.3, 1)"

export function prefersReducedShellMotion(): boolean {
  if (typeof window === "undefined") return false
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

export function shellModeTransitionMs(_to: AppShellMode): number {
  if (prefersReducedShellMotion()) return 0
  return SHELL_WIPE_MS
}

/** Slider translate target — workspace = 0, chat = -50%. */
export function shellTrackSlideClass(mode: AppShellMode): string {
  return mode === "chat" ? "app-shell-slider--chat" : "app-shell-slider--workspace"
}
