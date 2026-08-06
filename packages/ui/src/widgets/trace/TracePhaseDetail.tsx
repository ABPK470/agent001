/**
 * Phase detail — timeline, steps, accordion JSON blocks.
 * Timeline / step rows register for detail ↑↓; collapsibles for ←→ / Space.
 */

import { useRef } from "react"
import { JsonViewer } from "../../components/JsonViewer"
import { useRegisterDetailRow } from "../../components/review/DetailSectionContext"
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

function TracePhaseTimelineRow({
  kind,
  tone,
  displayText,
  offsetMs,
  showLine,
}: {
  kind: ReturnType<typeof timelineEventKind>
  tone: string | undefined
  displayText: string
  offsetMs: number
  showLine: boolean
}) {
  const rowRef = useRef<HTMLLIElement>(null)
  const { active, activate } = useRegisterDetailRow(rowRef)

  return (
    <li
      ref={rowRef}
      className={[
        "trace-phase-timeline__item",
        tone && tone !== "neutral" ? `is-${tone}` : "",
        `is-${kind}`,
        active ? "is-section-focused" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={activate}
    >
      <span className="trace-phase-timeline__rail" aria-hidden>
        <TimelineDot kind={kind} />
        {showLine ? <span className="trace-phase-timeline__line" /> : null}
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
}

function TracePhaseStepRow({
  index,
  name,
}: {
  index: number
  name: string
}) {
  const rowRef = useRef<HTMLLIElement>(null)
  const { active, activate } = useRegisterDetailRow(rowRef)

  return (
    <li
      ref={rowRef}
      className={`trace-phase-step${active ? " is-section-focused" : ""}`}
      onClick={activate}
    >
      <span className="trace-phase-step__idx tabular-nums">{index}</span>
      <div className="trace-phase-step__body">
        <div className="trace-phase-step__name font-mono">{name}</div>
      </div>
    </li>
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
              const kind = timelineEventKind(ev.text, ev.tone, isLast, outcome)
              return (
                <TracePhaseTimelineRow
                  key={ev.id}
                  kind={kind}
                  tone={ev.tone}
                  displayText={timelineEventDisplayText(ev.text, outcome)}
                  offsetMs={offsets[index] ?? 0}
                  showLine={index < timelineEvents.length - 1}
                />
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
              <TracePhaseStepRow key={step.id} index={i + 1} name={step.name} />
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
