import { Loader2 } from "lucide-react"
import type { OperationStatus } from "../../client/index"
import {
  operationStatusPill,
  operationStatusRowStroke,
  statusCalloutTone,
} from "../../lib/status-callout"
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

export const OP_LOG_WIDGET_FRAME_CLASS = "op-log-widget-frame"

/** @deprecated Prefer `OpLogStatusPill` in the status column. */
export function LogStatusLabel({
  status,
}: {
  status: OperationStatus
  compact?: boolean
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-0.5 ${operationStatusPill(status)}`}
    >
      {status === "running" && <Loader2 size={10} className="animate-spin" />}
      {status}
    </span>
  )
}
