import type { OperationKind, OperationStatus } from "../../api"
import { OperationKind as Kind } from "../../api"

/** Linear-style design tokens — flat list, subtle hover, no card chrome. */
export const AL = {
  row: "group relative flex min-h-[36px] items-center gap-2 px-3 py-1.5 text-[13px] leading-snug text-text transition-colors hover:bg-overlay-hover",
  rowButton: "group relative flex min-h-[36px] w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] leading-snug text-text transition-colors hover:bg-overlay-hover",
  rowCompact: "group relative flex min-h-[32px] items-center gap-2 px-3 py-1 text-[12px] leading-snug text-text transition-colors hover:bg-overlay-hover",
  rowCompactButton:
    "group relative flex min-h-[32px] w-full items-center gap-2 px-3 py-1 text-left text-[12px] leading-snug text-text transition-colors hover:bg-overlay-hover",
  title: "font-medium text-text truncate",
  subtitle: "text-text-muted truncate",
  meta: "shrink-0 tabular-nums text-[12px] text-text-muted",
  identifier: "shrink-0 font-mono text-[11px] text-text-faint uppercase tracking-wide",
  divider: "border-b border-border-subtle",
  sectionHeader:
    "sticky top-0 z-10 flex items-center gap-2 bg-canvas/95 px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-text-muted backdrop-blur-sm",
  nest: "border-l border-border-subtle ml-[18px] pl-0",
  action:
    "shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-overlay-2 hover:text-text",
  actionVisible:
    "shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-text-muted hover:bg-overlay-2 hover:text-text",
  panel: "mx-3 mb-2 rounded-md border border-border-subtle bg-panel/60 px-3 py-2",
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
