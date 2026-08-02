/**
 * Phase detail — timeline, steps, JSON blocks; scoped to selected tree node state.
 */

import { useState } from "react"
import { JsonViewer } from "../../components/JsonViewer"
import type { TracePhaseDetail, TracePhaseNode } from "./build-trace-dag"
import { TraceErrorBlock } from "./TraceErrorBlock"
import { TracePhaseEventText } from "./TracePhaseEventText"
import type { TraceSpanStatus } from "./trace-tree-index"

function eventIcon(tone: string | undefined): string {
  if (tone === "error") return "✕"
  if (tone === "warn") return "!"
  return "·"
}

export function TracePhaseDetail({
  phase,
  nodeStatus,
  nodeHasError,
}: {
  phase: TracePhaseNode
  nodeStatus: TraceSpanStatus
  nodeHasError: boolean
}) {
  const events = phase.details.filter(
    (d): d is Extract<TracePhaseDetail, { kind: "event" }> => d.kind === "event",
  )
  const steps = phase.details.filter(
    (d): d is Extract<TracePhaseDetail, { kind: "step" }> => d.kind === "step",
  )
  const jsonBlocks = phase.details.filter(
    (d): d is Extract<TracePhaseDetail, { kind: "json" }> => d.kind === "json",
  )
  const showErrorSurface = nodeHasError || nodeStatus === "failed"
  const errorEvents = events.filter((e) => e.tone === "error")
  const timelineEvents = showErrorSurface
    ? events
    : events.filter((e) => e.tone !== "error")
  const [openJsonIds, setOpenJsonIds] = useState(() => new Set<string>())

  function toggleJson(id: string) {
    setOpenJsonIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="trace-detail-body">
      {showErrorSurface ? (
        errorEvents.length > 0 ? (
          errorEvents.map((ev) => (
            <TraceErrorBlock key={ev.id} text={ev.text} title="ERROR / EXCEPTION TRACE" />
          ))
        ) : phase.status === "error" && phase.summary ? (
          <TraceErrorBlock text={phase.summary} title="ERROR / EXCEPTION TRACE" />
        ) : null
      ) : null}

      {timelineEvents.length > 0 && (
        <section className="trace-detail-section">
          <div className="trace-detail-section__label">Timeline</div>
          <ol className="trace-phase-timeline">
            {timelineEvents.map((ev, index) => (
              <li
                key={ev.id}
                className={`trace-phase-timeline__item${ev.tone && ev.tone !== "neutral" ? ` is-${ev.tone}` : ""}`}
              >
                <span className="trace-phase-timeline__rail" aria-hidden>
                  <span className="trace-phase-timeline__dot">{eventIcon(ev.tone)}</span>
                  {index < timelineEvents.length - 1 ? (
                    <span className="trace-phase-timeline__line" />
                  ) : null}
                </span>
                <div className="trace-phase-timeline__body">
                  <div className="trace-phase-timeline__text">
                    <TracePhaseEventText text={ev.text} />
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {steps.length > 0 && (
        <section className="trace-detail-section">
          <div className="trace-detail-section__label">Steps</div>
          <ol className="trace-phase-steps">
            {steps.map((step, i) => (
              <li key={step.id} className="trace-phase-step">
                <span className="trace-phase-step__idx tabular-nums">{i + 1}</span>
                <div className="trace-phase-step__body">
                  <div className="trace-phase-step__name font-mono">{step.name}</div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {jsonBlocks.map((block) => (
        <section key={block.id} className="trace-detail-section">
          <div className="trace-detail-section__header">
            <span className="trace-detail-section__label">{block.label}</span>
            <button
              type="button"
              className="trace-detail-section__expand"
              onClick={() => toggleJson(block.id)}
            >
              {openJsonIds.has(block.id) ? "Collapse" : "Expand"}
            </button>
          </div>
          {openJsonIds.has(block.id) ? (
            <JsonViewer value={block.value} copyable embedded inline />
          ) : null}
        </section>
      ))}
    </div>
  )
}
