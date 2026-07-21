/**
 * Planner phase card — Plan / Pipeline / Verify / Repair / step.
 *
 * Body is sectioned by detail kind (not a flat text dump):
 *   Events → timeline
 *   Steps  → named plan graph
 *   JSON   → collapsed raw payload
 *   Children → Call / Work nested under a step (subagent body)
 */

import { useRef, useState, type ReactNode } from "react"
import { JsonViewer } from "../../components/JsonViewer"
import { preserveScrollAnchor } from "../../lib/chatScroll"
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
  const [openId, setOpenId] = useState<string | null>(null)
  if (blocks.length === 0) return null

  return (
    <section className="trace-phase-section">
      <div className="trace-phase-section__label">Raw</div>
      {blocks.map((block) => (
        <PhaseJsonBlock
          key={block.id}
          block={block}
          open={openId === block.id}
          onToggle={() => setOpenId(openId === block.id ? null : block.id)}
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
  const buttonRef = useRef<HTMLButtonElement>(null)

  function onClick() {
    preserveScrollAnchor(buttonRef.current, onToggle)
  }

  return (
    <div className="trace-phase-json">
      <button
        ref={buttonRef}
        type="button"
        className="trace-phase-json__toggle"
        aria-expanded={open}
        onClick={onClick}
      >
        {open ? "Hide" : "Show"} {block.label}
      </button>
      {open && (
        <JsonViewer
          value={block.value}
          defaultExpandDepth={1}
          maxHeight={220}
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
            <div className="trace-scope-body trace-phase-body">
              <PhaseEvents events={events} />
              <PhaseSteps steps={steps} />
              <PhaseJson blocks={json} />
            </div>
          )}
          {hasNested && <div className="trace-phase-nested">{nested}</div>}
        </div>
      )}
    </article>
  )
}
