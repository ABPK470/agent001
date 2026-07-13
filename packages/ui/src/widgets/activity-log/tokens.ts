import type { OperationKind, OperationStatus } from "../../api"
import { OperationKind as Kind } from "../../api"

/**
 * Activity widget typography — matches app design tokens (text-sm body, text-xs labels).
 * Do not use sub-xs pixel sizes for readable content.
 */
export const AL = {
  /** Primary list row — 14px body, comfortable hit target */
  row: "group relative flex min-h-10 items-center gap-2.5 px-3 py-2 text-sm leading-normal text-text transition-colors hover:bg-overlay-hover",
  rowButton:
    "group relative flex min-h-10 w-full items-center gap-2.5 px-3 py-2 text-left text-sm leading-normal text-text transition-colors hover:bg-overlay-hover",
  /** Nested step / trace row — same 14px, slightly tighter padding */
  rowCompact:
    "group relative flex min-h-9 items-center gap-2.5 px-3 py-1.5 text-sm leading-normal text-text transition-colors hover:bg-overlay-hover",
  rowCompactButton:
    "group relative flex min-h-9 w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm leading-normal text-text transition-colors hover:bg-overlay-hover",
  title: "font-medium text-text truncate",
  subtitle: "text-sm text-text-muted truncate",
  meta: "shrink-0 tabular-nums text-sm text-text-muted",
  identifier: "shrink-0 font-mono text-xs text-text-faint uppercase tracking-wide",
  divider: "border-b border-border-subtle",
  sectionHeader:
    "sticky top-0 z-10 flex items-center gap-2 bg-canvas/95 px-3 py-2.5 text-xs font-semibold uppercase tracking-wider text-text-muted backdrop-blur-sm",
  nest: "border-l border-border-subtle ml-5 pl-0",
  action:
    "shrink-0 rounded px-2 py-1 text-sm font-medium text-text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-overlay-2 hover:text-text",
  actionVisible:
    "shrink-0 rounded px-2 py-1 text-sm font-medium text-text-muted hover:bg-overlay-2 hover:text-text",
  panel: "mx-3 mb-2 rounded-md border border-border-subtle bg-panel/60 px-3 py-2.5 text-sm",
} as const

export function statusColorClass(status: OperationStatus): string {
  switch (status) {
    case "success":
      return "text-success"
    case "failed":
      return "text-error"
    case "skipped":
      return "text-warning"
    case "running":
      return "text-info"
    case "cancelled":
      return "text-text-muted"
    default:
      return "text-text-muted"
  }
}

export function statusDotColor(status: OperationStatus): string {
  switch (status) {
    case "success":
      return "bg-success"
    case "failed":
      return "bg-error"
    case "skipped":
      return "bg-warning"
    case "running":
      return "bg-info"
    case "cancelled":
      return "bg-text-faint"
    default:
      return "bg-text-faint"
  }
}

export const KIND_META: Record<
  OperationKind,
  { label: string; color: string; abbrev: string }
> = {
  [Kind.AgentRun]: { label: "Agent", color: "var(--color-accent)", abbrev: "AGT" },
  [Kind.SyncPreview]: { label: "Preview", color: "var(--color-info)", abbrev: "PRV" },
  [Kind.SyncExecute]: { label: "Execute", color: "var(--color-success)", abbrev: "EXE" },
  [Kind.SyncRun]: { label: "Sync", color: "var(--color-info)", abbrev: "SYN" },
  [Kind.ProposerRun]: { label: "Scan", color: "var(--color-warning)", abbrev: "SCN" },
  [Kind.System]: { label: "System", color: "var(--color-text-muted)", abbrev: "SYS" },
}
