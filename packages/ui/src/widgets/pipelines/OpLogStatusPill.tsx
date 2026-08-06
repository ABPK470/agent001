/**
 * Pipelines status column — same micro pills as Trace master-detail tree.
 * Paint comes from statusCalloutTone; label follows the real status
 * (cancelled → Cancel, not ! Warn).
 */

import { Loader2 } from "lucide-react"
import type { OperationStatus } from "../../client/index"
import { operationStatusPill, statusAbbrevMeta } from "../../lib/status-callout"

export function OpLogStatusPill({ status }: { status: OperationStatus }) {
  const meta = statusAbbrevMeta(status)

  return (
    <span
      className={`${operationStatusPill(status)} trace-tree-status-pill op-log-status-pill`}
      title={meta.title}
    >
      {String(status).toLowerCase() === "running" ? (
        <Loader2 size={10} className="animate-spin op-log-status-pill__spin" aria-hidden />
      ) : (
        <span className="trace-tree-status-pill__icon" aria-hidden>
          {meta.icon}
        </span>
      )}
      <span className="trace-tree-status-pill__label">{meta.label}</span>
    </span>
  )
}
