/**
 * Trace tree status — governance-style micro pills (shared mia-status-pill tokens).
 */

import { operationStatusPill } from "../../lib/status-callout"
import type { TraceSpanStatus } from "./trace-tree-index"

const STATUS_META: Record<
  TraceSpanStatus,
  { label: string; icon: string; tone: string }
> = {
  success: { label: "OK", icon: "✓", tone: "success" },
  failed: { label: "Fail", icon: "✕", tone: "failed" },
  running: { label: "Run", icon: "…", tone: "running" },
  skipped: { label: "Skip", icon: "⊝", tone: "skipped" },
  cancelled: { label: "Cancel", icon: "–", tone: "cancelled" },
}

export function TraceTreeStatusBadge({
  status,
  branchHasError,
  hasError,
  onJumpToRootCause,
}: {
  status: TraceSpanStatus
  branchHasError: boolean
  hasError: boolean
  onJumpToRootCause?: () => void
}) {
  if (branchHasError && !hasError) {
    return (
      <button
        type="button"
        className={`${operationStatusPill("error")} trace-tree-status-pill`}
        title="Error in branch — jump to root cause"
        aria-label="Jump to root cause"
        onClick={(event) => {
          event.stopPropagation()
          onJumpToRootCause?.()
        }}
      >
        <span className="trace-tree-status-pill__icon" aria-hidden>
          !
        </span>
        <span className="trace-tree-status-pill__label">Err</span>
      </button>
    )
  }

  const meta = STATUS_META[status]
  return (
    <span
      className={`${operationStatusPill(meta.tone)} trace-tree-status-pill`}
      title={meta.label}
    >
      <span className="trace-tree-status-pill__icon" aria-hidden>
        {meta.icon}
      </span>
      <span className="trace-tree-status-pill__label">{meta.label}</span>
    </span>
  )
}

const DOT_TONE: Record<TraceSpanStatus, string> = {
  success: "is-success",
  failed: "is-failed",
  running: "is-running",
  skipped: "is-skipped",
  cancelled: "is-cancelled",
}

/** Tiny status marker on child row icons — replaces the text badge wall. */
export function TraceTreeStatusDot({
  status,
  branchHasError,
  hasError,
  onJumpToRootCause,
}: {
  status: TraceSpanStatus
  branchHasError: boolean
  hasError: boolean
  onJumpToRootCause?: () => void
}) {
  if (branchHasError && !hasError) {
    return (
      <button
        type="button"
        className="trace-tree-row__icon-dot is-error"
        title="Error in branch — jump to root cause"
        aria-label="Jump to root cause"
        onClick={(event) => {
          event.stopPropagation()
          onJumpToRootCause?.()
        }}
      />
    )
  }

  const meta = STATUS_META[status]
  return (
    <span
      className={`trace-tree-row__icon-dot ${DOT_TONE[status]}`}
      title={meta.label}
      aria-label={meta.label}
    />
  )
}
