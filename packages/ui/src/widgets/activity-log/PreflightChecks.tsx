import { useState } from "react"
import type { SyncDecisionEntry } from "../../components/DecisionLogPanel"
import { OperationStatus } from "../../api"
import { JsonViewer } from "../../components/JsonViewer"
import { statusColorClass } from "./tokens"
import { AL } from "./tokens"

function severityToStatus(severity: string | null | undefined): OperationStatus {
  if (severity === "error") return OperationStatus.Failed
  if (severity === "warning") return OperationStatus.Skipped
  return OperationStatus.Success
}

function PreflightRow({ decision }: { decision: SyncDecisionEntry }) {
  const status = severityToStatus(decision.severity)
  const hasDetails = decision.details != null && Object.keys(decision.details).length > 0
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        className={AL.rowCompactButton}
        onClick={() => hasDetails && setOpen((v) => !v)}
      >
        <span className="w-4 shrink-0" />
        <span className={`min-w-0 flex-1 truncate font-medium ${statusColorClass(status)}`}>
          {decision.title ?? decision.id}
        </span>
        {decision.summary ? (
          <span className={`hidden min-w-0 flex-1 truncate ${AL.subtitle} sm:inline`}>
            {decision.summary}
          </span>
        ) : null}
      </button>
      {open && hasDetails && (
        <div className={AL.panel}>
          <JsonViewer value={decision.details} label="details" defaultExpandDepth={2} maxHeight={240} />
        </div>
      )}
    </>
  )
}

export function PreflightChecks({ decisions }: { decisions: SyncDecisionEntry[] }) {
  return (
    <div className={AL.nest}>
      {decisions.map((d) => (
        <PreflightRow key={d.id} decision={d} />
      ))}
    </div>
  )
}
