import { ChevronRight, Loader2 } from "lucide-react"
import type { ReactNode } from "react"
import type { OperationStatus } from "./api"

export const OP_LOG = "text-[0.8125rem] leading-snug"
export const OP_LOG_MONO = `${OP_LOG} font-mono`

const STATUS_COLOR: Record<OperationStatus, string> = {
  running: "var(--color-info)",
  success: "var(--color-success)",
  failed: "var(--color-error)",
  cancelled: "var(--color-text-muted)",
  skipped: "var(--color-warning)",
  unknown: "var(--color-text-muted)",
}

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

export function statusTextClass(status: OperationStatus): string {
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

export function statusSoftBgClass(status: OperationStatus): string {
  switch (status) {
    case "success":
      return "bg-success-soft"
    case "failed":
      return "bg-error-soft"
    case "skipped":
      return "bg-warning-soft"
    case "running":
      return "bg-info-soft"
    default:
      return "bg-overlay-2"
  }
}

export const OP_LOG_MUTED = "text-text-muted"

/** Colored status badge — soft background + status-colored text (pipeline / parent rows). */
export function LogStatusLabel({
  status,
  compact,
}: {
  status: OperationStatus
  compact?: boolean
}) {
  return (
    <span
      className={`inline-flex items-center gap-0.5 shrink-0 rounded px-1.5 py-0.5 font-semibold uppercase tracking-wide ${compact ? "text-[10px]" : "text-[11px]"} ${statusSoftBgClass(status)} ${statusTextClass(status)}`}
    >
      {status === "running" && <Loader2 size={10} className="animate-spin" />}
      {status}
    </span>
  )
}

export function StatusDot({ status }: { status: OperationStatus }) {
  const color = STATUS_COLOR[status]
  if (status === "running") {
    return <Loader2 size={11} className="shrink-0 animate-spin" style={{ color }} />
  }
  return (
    <span
      className="w-[7px] h-[7px] rounded-full shrink-0"
      style={{ background: color }}
    />
  )
}

/** Bordered group — pipeline card or nested step group. */
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
  return (
    <div
      className={`rounded-md border border-border-subtle overflow-hidden bg-overlay-1/40 ${
        nested ? "ml-3 mt-0.5" : "mb-1 last:mb-0"
      }`}
    >
      {children}
    </div>
  )
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
  actions,
  linear,
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
  actions?: ReactNode
  linear?: boolean
}) {
  const textSize = linear ? "text-[13px]" : OP_LOG
  return (
    <>
      {showChevron ? (
        <ChevronRight
          size={linear ? 14 : 12}
          className={`shrink-0 text-text-muted transition-transform ${expanded ? "rotate-90" : ""} ${expandable ? "opacity-100" : "opacity-0"}`}
        />
      ) : (
        <span className="w-3.5 shrink-0" aria-hidden />
      )}
      {showStatus && status ? (
        <StatusDot status={status} />
      ) : (
        <span className="w-[7px] shrink-0" aria-hidden />
      )}
      <span className={`min-w-0 flex-1 truncate ${textSize}`}>
        <span className={`font-medium ${OP_LOG_MUTED}`}>{label}</span>
        {meta ? <span className={`font-normal ${OP_LOG_MUTED}`}> · {meta}</span> : null}
      </span>
      <span className={`shrink-0 tabular-nums w-14 text-right ${textSize} ${OP_LOG_MUTED}`}>
        {durationMs !== undefined ? fmtDuration(durationMs ?? null) : ""}
      </span>
      <span className={`shrink-0 tabular-nums w-[4.5rem] text-right ${textSize} ${OP_LOG_MUTED}`}>
        {timestamp ? fmtTime(timestamp) : ""}
      </span>
      {actions}
    </>
  )
}

/** Unified row — same layout at every depth; nesting via LogNest. */
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
}) {
  const rowClass = linear
    ? `flex items-center gap-2.5 px-3 py-2 text-left text-text transition-colors hover:bg-elevated/50 ${isLast ? "" : ""}`
    : `flex items-center gap-2 px-2.5 py-1.5 text-left text-text transition-colors hover:bg-overlay-2/80 ${isLast ? "" : "border-b border-border-subtle"}`

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
      actions={undefined}
      linear={linear}
    />
  )

  if (expandable && onToggle) {
    return (
      <>
        <div className={rowClass}>
          <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onToggle}>
            {cells}
          </button>
          {actions}
        </div>
        {expanded && children}
      </>
    )
  }

  return (
    <>
      <div className={rowClass}>
        {cells}
        {actions}
      </div>
      {expanded && children}
    </>
  )
}

/** Indent nested rows with a left rail (Linear-style). */
export function LogNest({
  children,
  linear,
}: {
  children: ReactNode
  linear?: boolean
}) {
  return (
    <div
      className={
        linear
          ? "border-l border-border-subtle ml-[1.125rem] pl-0"
          : "border-t border-border-subtle bg-base/20"
      }
    >
      {children}
    </div>
  )
}
