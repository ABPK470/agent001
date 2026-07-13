import { ChevronRight, Loader2 } from "lucide-react"
import type { ReactNode } from "react"
import type { OperationStatus } from "./api"

export const OP_LOG = "text-[0.8125rem] leading-snug text-text"
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

/** Status indicator — dot for terminal states; spinner only while running. */
export function StatusDot({ status }: { status: OperationStatus }) {
  const color = STATUS_COLOR[status]
  if (status === "running") {
    return <Loader2 size={11} className="shrink-0 animate-spin" style={{ color }} />
  }
  return (
    <span
      className="w-[11px] h-[11px] rounded-full shrink-0"
      style={{ background: color, opacity: 0.85 }}
    />
  )
}

function OpLogRowCells({
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
}) {
  return (
    <>
      {showChevron ? (
        <ChevronRight
          size={12}
          className={`shrink-0 transition-transform ${expanded ? "rotate-90" : ""} ${expandable ? "text-text" : "invisible"}`}
        />
      ) : (
        <span className="w-3 shrink-0" aria-hidden />
      )}
      {showStatus && status ? (
        <StatusDot status={status} />
      ) : (
        <span className="w-[11px] shrink-0" aria-hidden />
      )}
      <span className={`min-w-0 flex-1 break-all ${OP_LOG}`}>{label}</span>
      {meta ? <span className={`shrink-0 break-all max-w-[40%] ${OP_LOG}`}>{meta}</span> : null}
      <span className={`shrink-0 tabular-nums w-14 text-right ${OP_LOG}`}>
        {durationMs !== undefined ? fmtDuration(durationMs ?? null) : ""}
      </span>
      <span className={`shrink-0 tabular-nums w-20 text-right ${OP_LOG}`}>
        {timestamp ? fmtTime(timestamp) : ""}
      </span>
      {actions}
    </>
  )
}

/** Standard pipeline log row — same column layout everywhere. */
export function OpLogRow({
  status,
  expanded = false,
  expandable = false,
  onToggle,
  showChevron = true,
  showStatus = true,
  depth = 0,
  bordered = false,
  label,
  meta,
  durationMs,
  timestamp,
  actions,
  children,
}: {
  status?: OperationStatus
  expanded?: boolean
  expandable?: boolean
  onToggle?: () => void
  showChevron?: boolean
  showStatus?: boolean
  depth?: number
  bordered?: boolean
  label: ReactNode
  meta?: ReactNode
  durationMs?: number | null
  timestamp?: string | null
  actions?: ReactNode
  children?: ReactNode
}) {
  const cells = (
    <OpLogRowCells
      expanded={expanded}
      expandable={expandable}
      showChevron={showChevron}
      showStatus={showStatus}
      status={status}
      label={label}
      meta={meta}
      durationMs={durationMs}
      timestamp={timestamp}
      actions={actions}
    />
  )

  const wrapClass = bordered ? "rounded border border-border-subtle overflow-hidden" : ""
  const style = depth > 0 ? { marginLeft: depth * 12 } : undefined

  return (
    <div className={wrapClass} style={style}>
      {expandable && onToggle ? (
        <button
          type="button"
          className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-overlay-2 transition-colors ${OP_LOG}`}
          onClick={onToggle}
        >
          {cells}
        </button>
      ) : (
        <div className={`flex items-center gap-2 px-2.5 py-1.5 ${OP_LOG}`}>{cells}</div>
      )}
      {expanded && children}
    </div>
  )
}
