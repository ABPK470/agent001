/**
 * Shared design tokens used by tables, tool displays, and thread panels.
 * Resolved at runtime via CSS variables in `packages/ui/src/index.css`.
 */

export const C = {
  base: "var(--color-canvas)",
  surface: "var(--color-panel)",
  elevated: "var(--color-panel-2)",
  border: "var(--color-border-subtle)",
  borderSolid: "var(--color-border)",
  text: "var(--color-text)",
  textSecondary: "var(--color-text-secondary)",
  muted: "var(--color-text-muted)",
  dim: "var(--color-text-faint)",
  accent: "var(--color-accent)",
  accentHover: "var(--color-accent-hover)",
  success: "var(--color-success)",
  warning: "var(--color-warning)",
  error: "var(--color-error)",
  coral: "#EA6248",
  peach: "#F49D6C",
  plum: "#825776",
  cyan: "#6CB4EE",
} as const

/** Status mark kind — shape, not hue (light collapses status tokens to ink). */
export type StatusDotKind = "ok" | "fail" | "live" | "skip" | "muted"

export function statusDotKind(status: string): StatusDotKind {
  switch (status.toLowerCase()) {
    case "completed":
    case "succeeded":
    case "success":
      return "ok"
    case "failed":
    case "error":
    case "timeout":
      return "fail"
    case "running":
    case "pending":
    case "planning":
    case "waiting":
      return "live"
    case "cancelled":
    case "canceled":
    case "stopped":
    case "skipped":
      return "skip"
    default:
      return "muted"
  }
}

/** @deprecated Prefer `statusDotKind` + mark shapes; color collapses to ink on light. */
export function statusDot(status: string): string {
  switch (statusDotKind(status)) {
    case "ok":
      return C.success
    case "fail":
      return C.error
    case "live":
      return C.accent
    case "skip":
      return C.warning
    default:
      return C.muted
  }
}
