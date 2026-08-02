/**
 * Planner phase card — Plan / Pipeline / Verify / Repair / step.
 *
 * Body is sectioned by detail kind (not a flat text dump):
 *   Events → timeline
 *   Steps  → named plan graph
 *   JSON   → collapsed raw payload
 *   Children → Call / Work nested under a step (subagent body)
 */

import { Children, useState, type ReactNode } from "react"
import { JsonViewer } from "../../components/JsonViewer"
import { ScopeRow } from "./TraceScope"
import type { TracePhaseDetail, TracePhaseNode } from "./build-trace-dag"

function PhaseEvents({ events }: { events: Extract<TracePhaseDetail, { kind: "event" }>[] }) {
  if (events.length === 0) return null
  return (
    <section className="trace-phase-section">
      <div className="trace-phase-section__label">Timeline</div>
      <ul className="trace-phase-events">
        {events.map((ev) => (
          <li
            key={ev.id}
            className={`trace-phase-event${ev.tone && ev.tone !== "neutral" ? ` is-${ev.tone}` : ""}`}
          >
            {ev.text}
          </li>
        ))}
      </ul>
    </section>
  )
}

function PhaseSteps({ steps }: { steps: Extract<TracePhaseDetail, { kind: "step" }>[] }) {
  if (steps.length === 0) return null
  return (
    <section className="trace-phase-section">
      <div className="trace-phase-section__label">
        Steps
        <span className="trace-row__detail">{steps.length}</span>
      </div>
      <ol className="trace-phase-steps">
        {steps.map((step, i) => (
          <li key={step.id} className="trace-phase-step">
            <span className="trace-phase-step__idx tabular-nums">{i + 1}</span>
            <div className="trace-phase-step__body">
              <div className="trace-phase-step__name font-mono">{step.name}</div>
              <div className="trace-phase-step__meta">
                <span>
                  {step.type === "subagent_task" ? "subagent" : step.type.replace(/_/g, " ")}
                </span>
                {step.dependsOn && step.dependsOn.length > 0 && (
                  <span className="trace-phase-step__deps">
                    after {step.dependsOn.join(", ")}
                  </span>
                )}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

function PhaseJson({ blocks }: { blocks: Extract<TracePhaseDetail, { kind: "json" }>[] }) {
  // Independent opens — exclusive openId closed the sibling panel on every
  // toggle, so VirtualList remasured a double height delta and the whole
  // scrollport flinched. Mid-body Raw toggles must not use
  // preserveScrollAnchor (header-park fights TanStack resize).
  const [openIds, setOpenIds] = useState(() => new Set<string>())
  if (blocks.length === 0) return null

  function toggleJson(id: string) {
    setOpenIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <section className="trace-phase-section">
      <div className="trace-phase-section__label">Raw</div>
      {blocks.map((block) => (
        <PhaseJsonBlock
          key={block.id}
          block={block}
          open={openIds.has(block.id)}
          onToggle={() => toggleJson(block.id)}
        />
      ))}
    </section>
  )
}

function PhaseJsonBlock({
  block,
  open,
  onToggle,
}: {
  block: Extract<TracePhaseDetail, { kind: "json" }>
  open: boolean
  onToggle: () => void
}) {
  return (
    <div className="trace-phase-json">
      <button
        type="button"
        className="trace-phase-json__toggle"
        aria-expanded={open}
        onClick={onToggle}
      >
        {open ? "Hide" : "Show"} {block.label}
      </button>
      {open && (
        <JsonViewer
          value={block.value}
          defaultExpandDepth={1}
          inline
          className="trace-json"
        />
      )}
    </div>
  )
}

export function PhaseOutline({
  phase,
  open,
  onToggle,
  nested,
}: {
  phase: TracePhaseNode
  open: boolean
  onToggle: () => void
  /** Call / Work cards that belong inside this step. */
  nested?: ReactNode
}) {
  const hasDetails = phase.details.length > 0
  const hasNested = Boolean(nested)
  const expandable = hasDetails || hasNested
  const events = phase.details.filter((d): d is Extract<TracePhaseDetail, { kind: "event" }> => d.kind === "event")
  const steps = phase.details.filter((d): d is Extract<TracePhaseDetail, { kind: "step" }> => d.kind === "step")
  const json = phase.details.filter((d): d is Extract<TracePhaseDetail, { kind: "json" }> => d.kind === "json")

  return (
    <article className={`trace-card${open && expandable ? " is-open" : ""}`}>
      <ScopeRow
        scopeId={phase.id}
        kind="phase"
        depth={0}
        open={open && expandable}
        onToggle={onToggle}
        leading={phase.leading ?? phase.title}
        title={phase.leading ? phase.title : undefined}
        summary={phase.summary}
        soft
        expandable={expandable}
      />
      {open && expandable && (
        <div className="trace-card__body">
          {hasDetails && (
            /* Label column (align TIMELINE/RAW with SUBAGENT lead) — not peer gutter. */
            <div className="trace-scope-payload trace-phase-body">
              <PhaseEvents events={events} />
              <PhaseSteps steps={steps} />
              <PhaseJson blocks={json} />
            </div>
          )}
          {hasNested && (
            /* Peers under the phase — flush nest, stem under chevron (unchanged). */
            <div className="trace-phase-nested review-tree">
              {Children.map(nested, (child) =>
                child ? <div className="review-tree__item">{child}</div> : null,
              )}
            </div>
          )}
        </div>
      )}
    </article>
  )
}
