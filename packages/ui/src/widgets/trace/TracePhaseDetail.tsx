/**
 * Phase detail — timeline, steps, accordion JSON blocks.
 */

import { JsonViewer } from "../../components/JsonViewer"
import { formatMs } from "../../lib/util"
import type { TracePhaseDetail, TracePhaseNode } from "./build-trace-dag"
import { TraceDetailCollapsible } from "./TraceDetailCollapsible"
import { TraceToolErrorSection } from "./TraceToolIo"
import { TracePhaseEventText } from "./TracePhaseEventText"
import {
  buildTimelineOffsets,
  timelineEventDisplayText,
  timelineEventKind,
  timelinePhaseOutcome,
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
  branchHasError = false,
}: {
  phase: TracePhaseNode
  nodeStatus: TraceSpanStatus
  nodeHasError: boolean
  /** Tree rollup — timeline end chrome must match left-pane Err, not the word Finished. */
  branchHasError?: boolean
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
  const outcome = timelinePhaseOutcome({
    phaseStatus: phase.status,
    nodeStatus,
    nodeHasError,
    branchHasError,
  })
  const showErrorSurface = outcome === "failed"
  const errorEvents = events.filter((e) => e.tone === "error")
  const timelineEvents = showErrorSurface
    ? events
    : events.filter((e) => e.tone !== "error")
  const offsets = buildTimelineOffsets(timelineEvents, phase.durationMs)

  return (
    <div className="trace-detail-body">
      {showErrorSurface ? (
        errorEvents.length > 0 ? (
          errorEvents.map((ev) => (
            <TraceToolErrorSection key={ev.id} text={ev.text} />
          ))
        ) : phase.status === "error" && phase.summary ? (
          <TraceToolErrorSection text={phase.summary} />
        ) : null
      ) : null}

      {timelineEvents.length > 0 && (
        <section className="trace-detail-section trace-detail-section--timeline">
          <div className="trace-detail-section__label">Timeline</div>
          <ol className="trace-phase-timeline">
            {timelineEvents.map((ev, index) => {
              const isLast = index === timelineEvents.length - 1
              // Kind from original lifecycle text + tree outcome; copy may rewrite Finished→Failed.
              const kind = timelineEventKind(ev.text, ev.tone, isLast, outcome)
              const displayText = timelineEventDisplayText(ev.text, outcome)
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
                      <TracePhaseEventText text={displayText} />
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

      {jsonBlocks.map((block) => (
        <TraceDetailCollapsible
          key={block.id}
          label={block.label}
          defaultOpen={false}
          sticky={false}
        >
          <JsonViewer value={block.value} copyable embedded inline />
        </TraceDetailCollapsible>
      ))}
    </div>
  )
}
