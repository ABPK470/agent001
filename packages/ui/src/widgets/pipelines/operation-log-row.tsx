import { ChevronRight, Loader2, type LucideIcon } from "lucide-react"
import type { CSSProperties, ReactNode } from "react"
import type { OperationStatus } from "../../client/index"
import { ReviewTree, ReviewTreeItem } from "../../components/ReviewTree"
import {
  operationStatusPill,
  operationStatusRowStroke,
  statusCalloutTone,
} from "../../lib/status-callout"
import { OpLogEntityIcon } from "./OpLogEntityIcon"
import { OpLogStatusPill } from "./OpLogStatusPill"
export { OpLogErrorTreeRow } from "./OpLogErrorCallout"
export { opLogShowEntityIcon, opLogShowStatusPill } from "./op-log-row-policy"
export { truncateOpLogText } from "./op-log-text"

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

/** Status label ink — theme text; wash/border carry the status hue. */
export function statusTextClass(_status: OperationStatus): string {
  return "text-text"
}

export function statusSoftBgClass(status: OperationStatus): string {
  return operationStatusRowStroke(status)
}

export function statusFilterActiveClass(status: OperationStatus): string {
  switch (statusCalloutTone(status)) {
    case "ok":
      return "border-l-[3px] border-l-success text-text font-medium bg-transparent"
    case "err":
      return "border-l-[3px] border-l-error text-text font-semibold bg-transparent"
    case "skip":
      return "border border-dashed border-border text-text-muted font-medium bg-transparent"
    case "info":
      return "border-l-[3px] border-l-info text-text font-medium bg-transparent"
    case "warn":
      return "border-l-[3px] border-l-warning text-text font-medium bg-transparent"
    default:
      return "border border-border-subtle text-text-muted font-medium bg-transparent"
  }
}

export const OP_LOG_MUTED = "text-text-muted"
export const OP_LOG_DESC = "text-text-faint"

/** Pipelines row chrome — hover wash; expanded rows stay flat in the inspector timeline. */
export function opLogRowChromeClass(active?: boolean): string {
  return [
    "op-log-row-chrome rounded-[var(--list-row-radius)] transition-colors",
    active ? "op-log-row-chrome--active" : "",
  ]
    .filter(Boolean)
    .join(" ")
}

/** @deprecated Prefer `OpLogStatusPill` in the status column. */
export function LogStatusLabel({
  status,
}: {
  status: OperationStatus
  compact?: boolean
}) {
  return (
    <span
      className={`inline-flex items-center gap-0.5 shrink-0 ${operationStatusPill(status)}`}
    >
      {status === "running" && <Loader2 size={10} className="animate-spin" />}
      {status}
    </span>
  )
}

export const OP_LOG_WIDGET_FRAME_CLASS = "op-log-widget-frame"

export function OpLogTreeHeader({ wide = false }: { wide?: boolean }) {
  return (
    <div className="op-log-tree-header" aria-hidden>
      <div
        className={`op-log-row-grid op-log-row-grid--no-icon op-log-tree-header__grid${wide ? " op-log-row-grid--wide" : ""}`}
      >
        <span className="op-log-row-grid__chev review-chevron-slot" aria-hidden />
        <span className="op-log-row-grid__icon" aria-hidden />
        <span className="op-log-tree-header__node">Node</span>
        {wide ? <span className="op-log-tree-header__counts" aria-hidden /> : null}
        <span className="op-log-tree-header__metric op-log-tree-header__metric--status">Status</span>
        <span className="op-log-tree-header__metric op-log-tree-header__metric--duration">
          Duration
        </span>
        <span className="op-log-tree-header__metric op-log-tree-header__metric--time">Time</span>
      </div>
    </div>
  )
}

/** Grid-aligned nested payload — JSON / details stay in the node column. */
export function OpLogNestedBlock({
  children,
  depth = 0,
}: {
  children: ReactNode
  depth?: number
}) {
  const gridStyle: CSSProperties = {
    ["--op-log-depth" as string]: depth,
  }
  return (
    <div className="op-log-nested-block">
      <div className="op-log-row-grid op-log-row-grid--no-icon" style={gridStyle}>
        <span className="op-log-row-grid__chev review-chevron-slot" aria-hidden>
          <span className="op-log-row-grid__chev-spacer" />
        </span>
        <span className="op-log-row-grid__icon" aria-hidden />
        <div className="op-log-nested-block__content">{children}</div>
        <span className="op-log-row-grid__status" aria-hidden />
        <span className="op-log-row-grid__duration" aria-hidden />
        <span className="op-log-row-grid__time" aria-hidden />
      </div>
    </div>
  )
}

export function LogGroup({
  children,
  nested,
  flat,
}: {
  children: ReactNode
  nested?: boolean
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
  entityIcon,
  entityIconColor,
  status,
  showStatusPill = true,
  label,
  meta,
  metaTitle,
  counts,
  durationMs,
  timestamp,
  depth = 0,
  wide = false,
}: {
  expanded: boolean
  expandable: boolean
  showChevron: boolean
  entityIcon?: LucideIcon
  entityIconColor?: string
  status?: OperationStatus
  showStatusPill?: boolean
  label: ReactNode
  meta?: ReactNode
  metaTitle?: string
  counts?: ReactNode
  durationMs?: number | null
  timestamp?: string | null
  depth?: number
  wide?: boolean
}) {
  const textSize = OP_LOG
  const labelWeight = depth > 0 ? "font-normal" : "font-medium"
  const gridStyle: CSSProperties = {
    ["--op-log-depth" as string]: depth,
  }
  const labelInk = depth > 0 ? OP_LOG_MUTED : "text-text"
  const noIcon = !entityIcon
  return (
    <div
      className={`op-log-row-grid${wide ? " op-log-row-grid--wide" : ""}${noIcon ? " op-log-row-grid--no-icon" : ""}`}
      style={gridStyle}
    >
      <span className="op-log-row-grid__chev review-chevron-slot" aria-hidden={!expandable && !showChevron}>
        {showChevron && expandable ? (
          <ChevronRight
            size={13}
            strokeWidth={1.75}
            className={`text-text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
          />
        ) : (
          <span className="op-log-row-grid__chev-spacer" aria-hidden />
        )}
      </span>
      <span className="op-log-row-grid__icon">
        {entityIcon ? (
          <OpLogEntityIcon icon={entityIcon} color={entityIconColor} />
        ) : null}
      </span>
      <span className={`op-log-row-grid__label ${textSize}`}>
        <span className="op-log-row-grid__label-line" title={metaTitle}>
          <span className={`${labelWeight} ${labelInk}`}>{label}</span>
          {meta ? (
            <>
              <span className={OP_LOG_DESC}> · </span>
              <span className={OP_LOG_DESC}>{meta}</span>
            </>
          ) : null}
        </span>
      </span>
      {wide ? (
        <span className={`op-log-row-grid__counts review-meta ${OP_LOG_MUTED}`}>
          {counts ?? ""}
        </span>
      ) : null}
      <span className="op-log-row-grid__status">
        {showStatusPill && status ? <OpLogStatusPill status={status} /> : null}
      </span>
      <span className={`op-log-row-grid__duration review-meta ${OP_LOG_MUTED}`}>
        {durationMs !== undefined ? fmtDuration(durationMs ?? null) : ""}
      </span>
      <span className={`op-log-row-grid__time review-meta ${OP_LOG_MUTED}`}>
        {timestamp ? fmtTime(timestamp) : ""}
      </span>
    </div>
  )
}

export function OpLogRow({
  status,
  expanded = false,
  expandable = false,
  onToggle,
  showChevron = true,
  showStatusPill = true,
  entityIcon,
  entityIconColor,
  label,
  meta,
  metaTitle,
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
  showStatusPill?: boolean
  entityIcon?: LucideIcon
  entityIconColor?: string
  label: ReactNode
  meta?: ReactNode
  metaTitle?: string
  durationMs?: number | null
  timestamp?: string | null
  actions?: ReactNode
  children?: ReactNode
  linear?: boolean
  isLast?: boolean
  depth?: number
  treeItem?: boolean
}) {
  const activeFill = expanded && expandable
  const rowClass = linear
    ? [
        "flex items-center gap-2 py-2 pr-2 text-left text-text",
        opLogRowChromeClass(activeFill),
      ].join(" ")
    : [
        "flex items-center gap-2 py-1.5 pr-2.5 text-left text-text",
        isLast ? "" : "border-b border-border-subtle",
        opLogRowChromeClass(activeFill),
      ].join(" ")

  const cells = (
    <LogRowCells
      expanded={expanded}
      expandable={expandable}
      showChevron={showChevron}
      entityIcon={entityIcon}
      entityIconColor={entityIconColor}
      status={status}
      showStatusPill={showStatusPill}
      label={label}
      meta={meta}
      metaTitle={metaTitle}
      durationMs={durationMs}
      timestamp={timestamp}
      depth={depth}
    />
  )

  const rowInner = expandable && onToggle ? (
    <>
      <button type="button" className="flex min-w-0 flex-1 items-center text-left" onClick={onToggle}>
        {cells}
      </button>
      {actions}
    </>
  ) : (
    <>
      {cells}
      {actions}
    </>
  )

  const rowChrome = (
    <div className={rowClass}>
      {rowInner}
    </div>
  )

  if (!treeItem) {
    return (
      <div className="min-w-0">
        {rowChrome}
        {expanded && children}
      </div>
    )
  }

  return (
    <ReviewTreeItem>
      <div className="review-tree__row">{rowChrome}</div>
      {expanded && children ? <div className="review-tree__branch">{children}</div> : null}
    </ReviewTreeItem>
  )
}

export function PipelineRowCells({
  expanded,
  status,
  entityIcon,
  entityIconColor,
  title,
  subtitle,
  counts,
  durationMs,
  timestamp,
  wide = false,
}: {
  expanded: boolean
  status: OperationStatus
  entityIcon: LucideIcon
  entityIconColor: string
  title: ReactNode
  subtitle?: ReactNode
  counts?: ReactNode
  durationMs: number | null
  timestamp: string
  wide?: boolean
}) {
  return (
    <LogRowCells
      expanded={expanded}
      expandable
      showChevron
      entityIcon={entityIcon}
      entityIconColor={entityIconColor}
      status={status}
      label={title}
      meta={subtitle}
      counts={counts}
      durationMs={durationMs}
      timestamp={timestamp}
      wide={wide}
    />
  )
}

export function LogNest({
  children,
  linear,
  root,
  align = "flush",
}: {
  children: ReactNode
  linear?: boolean
  root?: boolean
  align?: "chevron" | "flush"
}) {
  void root
  void linear
  void align
  return <ReviewTree className="pb-1">{children}</ReviewTree>
}
