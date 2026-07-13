/**
 * Structured view of sync plan decisionLog entries (shown as "Preflight checks" in Pipelines).
 */

import { ChevronRight } from "lucide-react"
import { useState } from "react"
import { JsonViewer } from "./JsonViewer"

export interface SyncDecisionEntry {
  id: string
  title?: string
  summary?: string
  severity?: string | null
  stage?: string | null
  category?: string | null
  details?: Record<string, unknown>
}

const SEVERITY_TONE: Record<string, string> = {
  error: "bg-error-soft text-error border-error/30",
  warning: "bg-warning-soft text-warning border-warning/30",
  info: "bg-info-soft text-info border-info/30",
}

function severityTone(severity: string | null | undefined): string {
  if (!severity) return "bg-overlay-2 text-text-muted border-border-subtle"
  return SEVERITY_TONE[severity] ?? "bg-overlay-2 text-text-muted border-border-subtle"
}

function DecisionRow({ decision }: { decision: SyncDecisionEntry }) {
  const [open, setOpen] = useState(false)
  const hasDetails =
    decision.details != null && Object.keys(decision.details).length > 0

  return (
    <div className="rounded border border-border-subtle bg-base/50 overflow-hidden">
      <button
        type="button"
        className="w-full flex items-start gap-2 px-2.5 py-2 text-left hover:bg-overlay-2/50 transition-colors"
        onClick={() => hasDetails && setOpen((v) => !v)}
        disabled={!hasDetails}
      >
        {hasDetails ? (
          <ChevronRight
            size={12}
            className={`shrink-0 mt-0.5 text-text-muted/60 transition-transform ${open ? "rotate-90" : ""}`}
          />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {decision.severity && (
              <span
                className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${severityTone(decision.severity)}`}
              >
                {decision.severity}
              </span>
            )}
            {decision.category && (
              <span className="text-[10px] font-mono text-text-muted/60">{decision.category}</span>
            )}
            <span className="text-xs text-text font-medium">{decision.title ?? decision.id}</span>
          </div>
          {decision.summary && (
            <p className="text-xs text-text-muted leading-relaxed">{decision.summary}</p>
          )}
        </div>
      </button>
      {open && hasDetails && (
        <div className="px-2.5 pb-2.5 border-t border-border-subtle/80">
          <JsonViewer
            value={decision.details}
            label="details"
            defaultExpandDepth={2}
            maxHeight={240}
          />
        </div>
      )}
    </div>
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
    <div className="space-y-1.5">
      <p className="text-[10px] uppercase tracking-wide text-text-muted/60 px-0.5">
        Sync preview decisions · persisted on plan
      </p>
      {decisions.map((decision) => (
        <DecisionRow key={decision.id} decision={decision} />
      ))}
    </div>
  )
}
