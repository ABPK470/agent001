/** Chat ↔ workspace — left-to-right ASCII sweep. */

export const SHELL_MODE_SWEEP_MS = 520

export function prefersReducedShellMotion(): boolean {
  if (typeof window === "undefined") return false
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

export function shellModeSweepMs(): number {
  return prefersReducedShellMotion() ? 0 : SHELL_MODE_SWEEP_MS
}
