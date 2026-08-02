/**
 * Phase detail — timeline, steps, accordion JSON blocks.
 */

import { ChevronRight } from "lucide-react"
import { useState } from "react"
import { JsonViewer } from "../../components/JsonViewer"
import { formatMs } from "../../lib/util"
import type { TracePhaseDetail, TracePhaseNode } from "./build-trace-dag"
import { TraceErrorBlock } from "./TraceErrorBlock"
import { TracePhaseEventText } from "./TracePhaseEventText"
import {
  buildTimelineOffsets,
  timelineEventKind,
} from "./trace-phase-timeline-utils"
import type { TraceSpanStatus } from "./trace-tree-index"

function TimelineDot({ kind }: { kind: ReturnType<typeof timelineEventKind> }) {
  return (
    <span className={`trace-phase-timeline__dot is-${kind}`} aria-hidden>
      {kind === "error" ? "✕" : kind === "warn" ? "!" : kind === "complete" ? "✓" : "●"}
    </span>
  )
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
  const phaseDone = phase.status === "done" && !showErrorSurface
  const offsets = buildTimelineOffsets(timelineEvents, phase.durationMs)
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
        <section className="trace-detail-section trace-detail-section--timeline">
          <div className="trace-detail-section__label">Timeline</div>
          <ol className="trace-phase-timeline">
            {timelineEvents.map((ev, index) => {
              const kind = timelineEventKind(
                ev.text,
                ev.tone,
                index === timelineEvents.length - 1,
                phaseDone,
              )
              const offsetMs = offsets[index] ?? 0
              return (
                <li
                  key={ev.id}
                  className={`trace-phase-timeline__item${ev.tone && ev.tone !== "neutral" ? ` is-${ev.tone}` : ""} is-${kind}`}
                >
                  <span className="trace-phase-timeline__rail" aria-hidden>
                    <TimelineDot kind={kind} />
                    {index < timelineEvents.length - 1 ? (
                      <span className="trace-phase-timeline__line" />
                    ) : null}
                  </span>
                  <div className="trace-phase-timeline__body">
                    <div className="trace-phase-timeline__text">
                      <TracePhaseEventText text={ev.text} />
                    </div>
                    <span className="trace-phase-timeline__time tabular-nums">
                      {formatMs(offsetMs)}
                    </span>
                  </div>
                </li>
              )
            })}
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

      {jsonBlocks.map((block) => {
        const open = openJsonIds.has(block.id)
        return (
          <section key={block.id} className="trace-detail-section trace-detail-section--accordion">
            <button
              type="button"
              className="trace-detail-accordion"
              aria-expanded={open}
              onClick={() => toggleJson(block.id)}
            >
              <ChevronRight
                size={14}
                className={`trace-detail-accordion__chev${open ? " is-open" : ""}`}
                aria-hidden
              />
              <span className="trace-detail-accordion__label">{block.label}</span>
            </button>
            {open ? (
              <div className="trace-detail-accordion__body">
                <JsonViewer value={block.value} copyable embedded inline />
              </div>
            ) : null}
          </section>
        )
      })}
    </div>
  )
}
