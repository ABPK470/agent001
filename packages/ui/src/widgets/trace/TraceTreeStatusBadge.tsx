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
