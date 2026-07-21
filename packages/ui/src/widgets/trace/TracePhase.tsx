/**
 * Planner phase card — Route / Plan / Pipeline / Verify / Repair / step.
 * Same card dialect as Call / Context (sticky header, fold body).
 */

import { ScopeRow } from "./TraceScope"
import type { TracePhaseNode } from "./build-trace-dag"

export function PhaseOutline({
  phase,
  open,
  onToggle,
}: {
  phase: TracePhaseNode
  open: boolean
  onToggle: () => void
}) {
  return (
    <article className={`trace-card${open ? " is-open" : ""}`}>
      <ScopeRow
        scopeId={phase.id}
        kind="phase"
        depth={0}
        open={open}
        onToggle={onToggle}
        leading={phase.title}
        summary={phase.summary}
        soft
      />
      {open && phase.lines.length > 0 && (
        <div className="trace-card__body">
          <div className="trace-scope-body">
            {phase.lines.map((line) => (
              <div key={line} className="trace-row__detail py-0.5">
                {line}
              </div>
            ))}
          </div>
        </div>
      )}
    </article>
  )
}
