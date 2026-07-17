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

export function statusDot(status: string): string {
  switch (status) {
    case "completed":
      return C.success
    case "failed":
      return C.error
    case "running":
    case "pending":
    case "planning":
      return C.accent
    case "cancelled":
      return C.warning
    default:
      return C.muted
  }
}
