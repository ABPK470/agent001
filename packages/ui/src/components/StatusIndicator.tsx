import { StatusMark } from "./StatusMark"
import { statusDotKind, type StatusDotKind } from "../theme/tokens"

/**
 * Status row indicator — light: soft micro-badge (text + fill + border).
 * Dark: compact mark + label (shape dialect, no chroma wash).
 */
export function StatusIndicator({
  status,
  label,
  className = "",
}: {
  status: string
  /** Visible label; defaults to status string. */
  label?: string
  className?: string
}) {
  const kind = statusDotKind(status)
  const text = label ?? status
  return (
    <span
      className={["status-indicator", `status-indicator--${kind}`, className].filter(Boolean).join(" ")}
      data-kind={kind}
      title={text}
    >
      <StatusMark status={status} size="sm" className="status-indicator__mark" />
      <span className="status-indicator__label">{text}</span>
    </span>
  )
}

/** Map sync-history wire statuses to shared status-mark kinds. */
export function syncHistoryStatusLabel(status: string): string {
  switch (status) {
    case "success":
      return "Completed"
    case "failed":
      return "Failed"
    case "skipped":
      return "Skipped"
    case "started":
      return "Running"
    case "cancelled":
      return "Cancelled"
    default:
      return "Preview"
  }
}

export function syncHistoryStatusForMark(status: string): string {
  switch (status) {
    case "success":
      return "success"
    case "failed":
      return "failed"
    case "skipped":
      return "skipped"
    case "started":
      return "running"
    case "cancelled":
      return "cancelled"
    default:
      return "preview"
  }
}

export type { StatusDotKind }
