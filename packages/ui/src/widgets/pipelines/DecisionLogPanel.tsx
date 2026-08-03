/**
 * Structured view of sync plan decisionLog entries (shown as "Preflight checks" in Pipelines).
 */

import { useState } from "react"
import { ReviewDetailAccordion, ReviewPayloadBlock } from "../../components/review"
import { OP_LOG_MONO, OP_LOG_MUTED } from "./operation-log-row"

export interface SyncDecisionEntry {
  id: string
  title?: string
  summary?: string
  severity?: string | null
  stage?: string | null
  category?: string | null
  details?: Record<string, unknown>
}

function DecisionAccordion({ decision }: { decision: SyncDecisionEntry }) {
  const hasDetails =
    decision.details != null && Object.keys(decision.details).length > 0
  const [open, setOpen] = useState(hasDetails)

  return (
    <ReviewDetailAccordion
      label={decision.title ?? decision.id}
      open={open}
      onToggle={() => setOpen((v) => !v)}
    >
      {decision.summary ? (
        <p className={`${OP_LOG_MONO} ${OP_LOG_MUTED} mb-2 text-sm`}>{decision.summary}</p>
      ) : null}
      {hasDetails ? (
        <ReviewPayloadBlock value={decision.details} label="details" maxHeight={240} />
      ) : null}
    </ReviewDetailAccordion>
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

export function DecisionLogPanel({ decisions }: { decisions: SyncDecisionEntry[] }) {
  return (
    <div className="flex flex-col gap-0">
      {decisions.map((decision) => (
        <DecisionAccordion key={decision.id} decision={decision} />
      ))}
    </div>
  )
}
