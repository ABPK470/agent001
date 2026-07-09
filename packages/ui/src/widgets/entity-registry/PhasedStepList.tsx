import type { JSX } from "react"
import type { AuthoredSyncFlowStep } from "../../types"

const REGION_LABEL = {
  before: "Before metadata transaction",
  metadata: "Metadata transaction",
  after: "After metadata transaction",
} as const

/**
 * Ordered flow steps with explicit region markers at metadataSync.
 * Region = array position, not a separate phase catalog.
 */
export function PhasedStepList({ steps }: { steps: AuthoredSyncFlowStep[] }): JSX.Element | null {
  if (steps.length === 0) return null

  const metadataIndex = steps.findIndex((step) => step.kind === "metadataSync")

  return (
    <ol className="rounded-lg border border-border-subtle">
      {steps.map((step, index) => {
        const regionHeader =
          index === 0 && metadataIndex !== 0
            ? REGION_LABEL.before
            : index === metadataIndex
              ? REGION_LABEL.metadata
              : index === metadataIndex + 1 && metadataIndex >= 0
                ? REGION_LABEL.after
                : null

        return (
          <li key={step.id || `${step.kind}-${index}`}>
            {regionHeader && (
              <div className="border-b border-border/40 bg-elevated/30 px-3 py-1 text-xs font-medium uppercase tracking-wider text-text-muted">
                {regionHeader}
              </div>
            )}
            <div className="flex items-baseline gap-3 border-b border-border/15 px-3 py-1.5 text-xs last:border-b-0">
              <span className="w-5 shrink-0 text-right font-mono tabular-nums text-text-faint">{index + 1}</span>
              <span className="font-mono text-text">{step.kind}</span>
              {step.title && step.title !== step.id && (
                <span className="truncate text-text-muted">{step.title}</span>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
