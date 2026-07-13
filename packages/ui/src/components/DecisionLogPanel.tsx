/**
 * Structured view of sync plan decisionLog entries (shown as "Preflight checks" in Pipelines).
 */

import { useState } from "react"
import { OperationStatus } from "../api"
import { JsonViewer } from "./JsonViewer"
import { OP_LOG_MONO, OP_LOG_MUTED, OpLogRow } from "../operation-log-row"

export interface SyncDecisionEntry {
  id: string
  title?: string
  summary?: string
  severity?: string | null
  stage?: string | null
  category?: string | null
  details?: Record<string, unknown>
}

function severityToStatus(severity: string | null | undefined): OperationStatus {
  if (severity === "error") return OperationStatus.Failed
  if (severity === "warning") return OperationStatus.Skipped
  return OperationStatus.Success
}

function DecisionRow({
  decision,
  linear,
  isLast,
  depth = 0,
}: {
  decision: SyncDecisionEntry
  linear?: boolean
  isLast?: boolean
  depth?: number
}) {
  const status = severityToStatus(decision.severity)
  const hasDetails =
    decision.details != null && Object.keys(decision.details).length > 0
  const [expanded, setExpanded] = useState(false)

  return (
    <OpLogRow
      linear={linear}
      isLast={isLast && !expanded}
      depth={depth}
      status={status}
      expanded={expanded}
      expandable={hasDetails}
      onToggle={() => setExpanded((v) => !v)}
      showChevron={hasDetails}
      label={
        <span className={`${OP_LOG_MONO} ${OP_LOG_MUTED}`}>
          {decision.title ?? decision.id}
        </span>
      }
      meta={decision.summary ?? undefined}
    >
      {hasDetails && (
        <div className={`px-2.5 py-1.5 ${linear ? "bg-elevated/30" : "bg-base/30 border-t border-border-subtle"}`}>
          <JsonViewer
            value={decision.details}
            label="details"
            defaultExpandDepth={2}
            maxHeight={240}
          />
        </div>
      )}
    </OpLogRow>
  )
}

export function isSyncDecisionLogDetails(
  details: Record<string, unknown>,
): details is { decisions: SyncDecisionEntry[] } {
  const decisions = details["decisions"]
  if (!Array.isArray(decisions) || decisions.length === 0) return false
  return decisions.every(
    (entry) =>
      entry != null &&
      typeof entry === "object" &&
      typeof (entry as SyncDecisionEntry).id === "string",
  )
}

export function DecisionLogPanel({
  decisions,
  linear,
  depth = 0,
}: {
  decisions: SyncDecisionEntry[]
  linear?: boolean
  depth?: number
}) {
  return (
    <>
      {decisions.map((decision, idx) => (
        <DecisionRow
          key={decision.id}
          decision={decision}
          linear={linear}
          depth={depth}
          isLast={idx === decisions.length - 1}
        />
      ))}
    </>
  )
}
