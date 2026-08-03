/**
 * Right-pane detail for a selected pipeline or activity scope.
 * Payloads live here — not inline under the left tree (Trace contract).
 */

import { useState, type ReactNode } from "react"
import type { OperationActivity, OperationEvent, OperationPipeline } from "../../client/index"
import { OperationKind } from "../../client/index"
import {
  ReviewDetailAccordion,
  ReviewDetailErrorCallout,
  ReviewDetailHeadline,
  ReviewPayloadBlock,
} from "../../components/review"
import { ToolIoBlock } from "../chat/ToolCallModal"
import { coerceToolIoFromActivity, readToolIoFromEvent } from "../chat/tool-call-io"
import { isSyncHttpEventType, readHttpTraceFields } from "../sync/trace/sync-http-trace"
import { isSyncSqlEventType, readSqlTraceFields } from "../sync/trace/sync-sql-trace"
import { DecisionLogPanel, isSyncDecisionLogDetails } from "./DecisionLogPanel"
import { OpLogStatusPill } from "./OpLogStatusPill"
import {
  OP_LOG,
  OP_LOG_MUTED,
  fmtDuration,
  fmtTime,
} from "./operation-log-row"

export type OpLogSelection =
  | { kind: "pipeline"; pipelineId: string }
  | { kind: "activity"; pipelineId: string; activityKey: string }

export function findActivityByKey(
  pipeline: OperationPipeline,
  activityKey: string,
  keyOf: (pipelineId: string, activityId: string, parentKey?: string) => string,
): OperationActivity | null {
  function walk(activities: OperationActivity[], parentKey?: string): OperationActivity | null {
    for (const activity of activities) {
      const key = keyOf(pipeline.id, activity.id, parentKey)
      if (key === activityKey) return activity
      if (activity.children?.length) {
        const found = walk(activity.children, key)
        if (found) return found
      }
    }
    return null
  }
  return walk(pipeline.activities)
}

function activityPipelineKind(pipelineKind: OperationKind, parentPhaseId?: string): OperationKind {
  if (pipelineKind !== OperationKind.SyncRun) return pipelineKind
  if (parentPhaseId === "phase:preview") return OperationKind.SyncPreview
  if (parentPhaseId === "phase:execute") return OperationKind.SyncExecute
  return pipelineKind
}

function findPhaseId(
  pipeline: OperationPipeline,
  activityKey: string,
  keyOf: (pipelineId: string, activityId: string, parentKey?: string) => string,
): string | undefined {
  function walk(
    activities: OperationActivity[],
    parentKey: string | undefined,
    parentPhaseId: string | undefined,
  ): string | undefined {
    for (const activity of activities) {
      const key = keyOf(pipeline.id, activity.id, parentKey)
      const phaseId = activity.id.startsWith("phase:") ? activity.id : parentPhaseId
      if (key === activityKey) return phaseId
      if (activity.children?.length) {
        const found = walk(activity.children, key, phaseId)
        if (found) return found
      }
    }
    return undefined
  }
  return walk(pipeline.activities, undefined, undefined)
}

function PipelineOverview() {
  return (
    <div className="op-log-scope-detail__body px-4 py-3">
      <p className={`${OP_LOG_MUTED} op-log-scope-detail__intro text-sm leading-relaxed`}>
        Select a step in the tree to inspect payloads, tool I/O, and event data.
      </p>
    </div>
  )
}

function OpenAccordion({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <ReviewDetailAccordion label={label} open={open} onToggle={() => setOpen((v) => !v)}>
      {children}
    </ReviewDetailAccordion>
  )
}

function EventPayloadAccordion({ ev, label }: { ev: OperationEvent; label: string }) {
  const [open, setOpen] = useState(true)
  const toolIo = readToolIoFromEvent(ev)

  let body: ReactNode
  if (toolIo) {
    body = <ToolIoBlock io={toolIo} compact maxHeight={420} />
  } else if (isSyncSqlEventType(ev.type)) {
    const fields = readSqlTraceFields(ev.data)
    body = <ReviewPayloadBlock value={fields ?? ev.data} label="sql" />
  } else if (isSyncHttpEventType(ev.type)) {
    const fields = readHttpTraceFields(ev.data)
    body = <ReviewPayloadBlock value={fields ?? ev.data} label="http" />
  } else if (ev.data && Object.keys(ev.data).length > 0) {
    body = <ReviewPayloadBlock value={ev.data} label="event" />
  } else {
    body = <p className={`${OP_LOG_MUTED} text-sm`}>No payload on this event.</p>
  }

  return (
    <ReviewDetailAccordion
      label={label}
      open={open}
      onToggle={() => setOpen((v) => !v)}
    >
      {body}
    </ReviewDetailAccordion>
  )
}

function ActivityDetail({
  pipeline,
  activity,
  activityKey,
  keyOf,
}: {
  pipeline: OperationPipeline
  activity: OperationActivity
  activityKey: string
  keyOf: (pipelineId: string, activityId: string, parentKey?: string) => string
}) {
  const phaseId = findPhaseId(pipeline, activityKey, keyOf)
  const effectiveKind = activityPipelineKind(pipeline.kind, phaseId)
  const toolIo = coerceToolIoFromActivity(activity)
  const sqlEvents = activity.events.filter((ev) => isSyncSqlEventType(ev.type))
  const httpEvents = activity.events.filter((ev) => isSyncHttpEventType(ev.type))
  const otherEvents = activity.events.filter(
    (ev) => !isSyncSqlEventType(ev.type) && !isSyncHttpEventType(ev.type),
  )
  const isResultRow = activity.name === "result"
  const isAgentTool =
    effectiveKind === OperationKind.AgentRun && toolIo != null && !isResultRow

  return (
    <div className="op-log-scope-detail__body flex min-h-0 flex-col gap-1 px-4 py-3">
      <ReviewDetailHeadline
        primary={
          <div className="flex min-w-0 items-center gap-2 px-0 py-0">
            <h3 className={`min-w-0 flex-1 truncate ${OP_LOG} font-semibold text-text`}>
              {activity.name}
            </h3>
            <OpLogStatusPill status={activity.status} />
          </div>
        }
        secondary={
          <>
            {activity.summary ? (
              <p className={`${OP_LOG_MUTED} text-sm`}>{activity.summary}</p>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 review-meta text-text-muted">
              <span>{fmtDuration(activity.durationMs)}</span>
              <span>{fmtTime(activity.startedAt)}</span>
            </div>
          </>
        }
        error={
          activity.error ? (
            <ReviewDetailErrorCallout message={activity.error} />
          ) : undefined
        }
      />

      {isAgentTool && toolIo ? (
        <OpenAccordion label="Tool I/O">
          <ToolIoBlock io={toolIo} compact maxHeight={420} />
        </OpenAccordion>
      ) : null}

      {isResultRow && activity.events[0] ? (
        <OpenAccordion label="Result">
          <ReviewPayloadBlock value={activity.events[0].data} label="result" maxHeight={480} />
        </OpenAccordion>
      ) : null}

      {!isResultRow && !isAgentTool && activity.events.length === 0 && activity.details ? (
        isSyncDecisionLogDetails(activity.details) ? (
          <DecisionLogPanel decisions={activity.details.decisions} />
        ) : toolIo ? (
          <OpenAccordion label="Tool I/O">
            <ToolIoBlock io={toolIo} compact maxHeight={420} />
          </OpenAccordion>
        ) : (
          <OpenAccordion label="Details">
            <ReviewPayloadBlock value={activity.details} label="details" />
          </OpenAccordion>
        )
      ) : null}

      {sqlEvents.map((ev, idx) => (
        <EventPayloadAccordion key={`sql:${idx}`} ev={ev} label={`SQL · ${ev.type}`} />
      ))}
      {httpEvents.map((ev, idx) => (
        <EventPayloadAccordion key={`http:${idx}`} ev={ev} label={`HTTP · ${ev.type}`} />
      ))}
      {!isResultRow &&
        !isAgentTool &&
        otherEvents.map((ev, idx) => (
          <EventPayloadAccordion key={`ev:${idx}`} ev={ev} label={ev.type} />
        ))}

      {!activity.error &&
      !toolIo &&
      !isResultRow &&
      sqlEvents.length === 0 &&
      httpEvents.length === 0 &&
      otherEvents.length === 0 &&
      !activity.details ? (
        <p className={`${OP_LOG_MUTED} px-0 py-2 text-sm`}>
          {(activity.children?.length ?? 0) > 0
            ? "This step has nested children — select one in the tree."
            : "No payload recorded for this step."}
        </p>
      ) : null}
    </div>
  )
}

export function OperationLogScopeDetail({
  pipeline,
  selection,
  keyOf,
}: {
  pipeline: OperationPipeline | null
  selection: OpLogSelection | null
  keyOf: (pipelineId: string, activityId: string, parentKey?: string) => string
}) {
  if (!pipeline || !selection || selection.pipelineId !== pipeline.id) {
    return null
  }

  if (selection.kind === "pipeline") {
    return <PipelineOverview />
  }

  const activity = findActivityByKey(pipeline, selection.activityKey, keyOf)
  if (!activity) {
    return (
      <div className="op-log-scope-detail__body px-4 py-3">
        <p className={`${OP_LOG_MUTED} text-sm`}>Step not found in this run.</p>
      </div>
    )
  }

  return (
    <ActivityDetail
      pipeline={pipeline}
      activity={activity}
      activityKey={selection.activityKey}
      keyOf={keyOf}
    />
  )
}
