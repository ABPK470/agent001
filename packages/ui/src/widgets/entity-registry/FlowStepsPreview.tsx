/**
 * Read-only preview of steps resolved from a flow reference.
 */

import type { JSX } from "react"
import type { AuthoredSyncFlowStep } from "../../types"
import { PhasedStepList } from "./PhasedStepList"

export function FlowStepsPreview({
  flowId,
  steps,
  emptyMessage = "This flow has no steps yet. Add them in Configuration → Flows.",
}: {
  flowId: string
  steps: AuthoredSyncFlowStep[]
  emptyMessage?: string
}): JSX.Element {
  if (steps.length === 0) {
    return <p className="text-sm text-text-muted">{emptyMessage}</p>
  }

  return (

      <PhasedStepList steps={steps} />

  )
}
