import { ChevronRight, Loader2 } from "lucide-react"
import type { ReactNode } from "react"
import type { OperationStatus } from "../../client/index"
import { ReviewTree, ReviewTreeItem } from "../../components/ReviewTree"

export const OP_LOG = "text-sm leading-snug"
export const OP_LOG_MONO = `${OP_LOG} font-mono`

export function fmtDuration(ms: number | null): string {
  if (ms == null) return "—"
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m ${s}s`
}

export function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleTimeString(undefined, { hour12: false })
}

export function fmtDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
}

export function formatPipelineSubtitle(subtitle: string): string {
  return subtitle.replace(
    /\bdef\s+(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)/g,
    (_, iso: string) => `def ${fmtDateTime(iso)}`,
  )
}

/** Ink-first: light collapses hue to ink; meaning from weight + border dialect. */
export function statusTextClass(status: OperationStatus): string {
  switch (status) {
    case "success":
      return "text-text-muted"
    case "failed":
      return "text-text"
    case "skipped":
      return "text-text-faint"
    case "running":
      return "text-text"
    case "cancelled":
      return "text-text-muted"
    default:
      return "text-text-muted"
  }
}

/**
 * Status chrome without traffic chroma — label + quiet border dialect
 * (success subtle, failed stronger wash, skipped dashed, running strong).
 * Never border-2 / full-ink frames — too loud on paper and dark.
 */
export function statusSoftBgClass(status: OperationStatus): string {
  switch (status) {
    case "success":
      return "border border-border-subtle bg-transparent"
    case "failed":
      return "border border-border-strong bg-overlay-2"
    case "skipped":
      return "border border-dashed border-border bg-transparent"
    case "running":
      return "border border-border bg-overlay-1"
    default:
      return "border border-border-subtle bg-transparent"
  }
}

export function statusFilterActiveClass(status: OperationStatus): string {
  switch (status) {
    case "success":
      return "ring-1 ring-inset ring-border-subtle text-text-muted font-medium bg-transparent"
    case "failed":
      return "ring-1 ring-inset ring-border-strong text-text font-semibold bg-overlay-2"
    case "skipped":
      return "border border-dashed border-border text-text-faint font-medium bg-transparent"
    case "running":
      return "ring-1 ring-inset ring-border-strong text-text font-medium bg-transparent"
    case "cancelled":
      return "ring-1 ring-inset ring-border text-text font-medium bg-transparent"
    default:
      return "ring-1 ring-inset ring-border-subtle text-text-muted font-medium bg-transparent"
  }
}
export const OP_LOG_MUTED = "text-text-muted"
/** Description / summary after the middle dot — one step lighter than the label. */
export const OP_LOG_DESC = "text-text-faint"

/** Status badge — uppercase label + border dialect (not traffic chroma). */
export function LogStatusLabel({
  status,
}: {
  status: OperationStatus
  /** @deprecated Size is fixed; kept for call-site compat. */
  compact?: boolean
}) {
  return (
    <span
      className={`inline-flex items-center gap-0.5 shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${statusSoftBgClass(status)} ${statusTextClass(status)}`}
    >
      {status === "running" && <Loader2 size={10} className="animate-spin" />}
      {status}
    </span>
  )
}

/** Mark shape carries meaning when hue collapses to ink (filled / ring / dashed / spin). */
export function StatusDot({ status }: { status: OperationStatus }) {
  if (status === "running") {
    return <Loader2 size={11} className="shrink-0 animate-spin text-text-muted" aria-hidden />
  }
  if (status === "failed") {
    return <span className="w-[7px] h-[7px] rounded-full shrink-0 bg-text" aria-hidden />
  }
  if (status === "success") {
    return (
      <span
        className="w-[7px] h-[7px] rounded-full shrink-0 border-[1.5px] border-text bg-transparent"
        aria-hidden
      />
    )
  }
  if (status === "skipped") {
    return (
      <span
        className="w-[7px] h-[7px] rounded-full shrink-0 border border-dashed border-text-muted bg-transparent"
        aria-hidden
      />
    )
  }
  return <span className="w-[7px] h-[7px] rounded-full shrink-0 bg-text-muted/40" aria-hidden />
}

/**
 * Pipeline / step group — flush list chrome (no nested grey plates).
 * Nested groups use the shared ReviewTree.
 */
export function LogGroup({
  children,
  nested,
  flat,
}: {
  children: ReactNode
  nested?: boolean
  /** Linear variant: no outer border. */
  flat?: boolean
}) {
  if (flat) {
    return <div className="divide-y divide-border-subtle">{children}</div>
  }
  if (nested) {
    return <ReviewTree className="mt-0.5">{children}</ReviewTree>
  }
  return <div className="mb-1 border-b border-border-subtle last:mb-0 last:border-b-0">{children}</div>
}

function LogRowCells({
  expanded,
  expandable,
  showChevron,
  showStatus,
  status,
  label,
  meta,
  durationMs,
  timestamp,
  depth = 0,
}: {
  expanded: boolean
  expandable: boolean
  showChevron: boolean
  showStatus: boolean
  status?: OperationStatus
  label: ReactNode
  meta?: ReactNode
  durationMs?: number | null
  timestamp?: string | null
  depth?: number
}) {
  const textSize = OP_LOG
  const labelWeight = depth > 0 ? "font-normal" : "font-medium"
  return (
    <>
      <span className="review-chevron-slot" aria-hidden={!showChevron}>
        {showChevron ? (
          <ChevronRight
            size={13}
            strokeWidth={1.75}
            className={`text-text-muted transition-transform ${expanded ? "rotate-90" : ""} ${expandable ? "opacity-100" : "opacity-0"}`}
          />
        ) : null}
      </span>
      {showStatus && status ? (
        <StatusDot status={status} />
      ) : (
        <span className="w-[7px] shrink-0" aria-hidden />
      )}
      <span className={`min-w-0 flex-1 truncate ${textSize}`}>
        <span className={`${labelWeight} ${OP_LOG_MUTED}`}>{label}</span>
        {meta ? <span className={`font-normal ${OP_LOG_DESC}`}> · {meta}</span> : null}
      </span>
      <span className={`shrink-0 review-meta w-14 text-right ${OP_LOG_MUTED}`}>
        {durationMs !== undefined ? fmtDuration(durationMs ?? null) : ""}
      </span>
      <span className={`shrink-0 review-meta w-[4.5rem] text-right ${OP_LOG_MUTED}`}>
        {timestamp ? fmtTime(timestamp) : ""}
      </span>
    </>
  )
}

/**
 * Unified row. When `treeItem`, wraps as ReviewTreeItem (required inside LogNest).
 * Root pipeline headers set `treeItem={false}`.
 */
export function OpLogRow({
  status,
  expanded = false,
  expandable = false,
  onToggle,
  showChevron = true,
  showStatus = true,
  label,
  meta,
  durationMs,
  timestamp,
  actions,
  children,
  linear,
  isLast,
  depth = 0,
  treeItem = true,
}: {
  status?: OperationStatus
  expanded?: boolean
  expandable?: boolean
  onToggle?: () => void
  showChevron?: boolean
  showStatus?: boolean
  label: ReactNode
  meta?: ReactNode
  durationMs?: number | null
  timestamp?: string | null
  actions?: ReactNode
  children?: ReactNode
  linear?: boolean
  isLast?: boolean
  depth?: number
  /** Wrap in ReviewTreeItem (default true — nest peers). */
  treeItem?: boolean
}) {
  // pl-0 — chevron slot centers on --review-tree-x; nested LogNest stays flush.
  const activeFill = expanded && expandable
  const rowClass = linear
    ? [
        "flex items-center gap-2 py-2 pr-2 text-left text-text rounded-[var(--list-row-radius)] transition-colors",
        activeFill ? "bg-[var(--select-fill)]" : "hover:bg-[var(--hover-fill)]",
      ].join(" ")
    : [
        "flex items-center gap-2 py-1.5 pr-2.5 text-left text-text rounded-[var(--list-row-radius)] transition-colors",
        isLast ? "" : "border-b border-border-subtle",
        activeFill ? "bg-[var(--select-fill)]" : "hover:bg-[var(--hover-fill)]",
      ].join(" ")

  const cells = (
    <LogRowCells
      expanded={expanded}
      expandable={expandable}
      showChevron={showChevron}
      showStatus={showStatus}
      status={status}
      label={label}
      meta={meta}
      durationMs={durationMs}
      timestamp={timestamp}
      depth={depth}
    />
  )

  const row = expandable && onToggle ? (
    <>
      <div className={rowClass}>
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onToggle}>
          {cells}
        </button>
        {actions}
      </div>
      {expanded && children}
    </>
  ) : (
    <>
      <div className={rowClass}>
        {cells}
        {actions}
      </div>
      {expanded && children}
    </>
  )

  if (!treeItem) return <div className="min-w-0">{row}</div>
  return <ReviewTreeItem>{row}</ReviewTreeItem>
}

/**
 * Nested peers under a pipeline / activity.
 *
 * Hard: render LogNest *inside* the parent OpLogRow / ReviewTreeItem.
 * As a sibling it punches a hole in the parent stem (Configured → Preview gap).
 *
 * Nest is flush with the parent row — stem under `.review-chevron-slot` center
 * (same as Threads). Never wrap in pl-* (that parks the stem under content).
 */
export function LogNest({
  children,
  linear,
  root,
  align = "flush",
}: {
  children: ReactNode
  linear?: boolean
  /** @deprecated unused — kept for call-site compat */
  root?: boolean
  /** @deprecated always flush — stem under chevron via shared tokens */
  align?: "chevron" | "flush"
}) {
  void root
  void linear
  void align
  return <ReviewTree className="pb-1">{children}</ReviewTree>
}
