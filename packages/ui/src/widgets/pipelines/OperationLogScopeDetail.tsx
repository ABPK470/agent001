/**
 * Right-pane detail for a selected pipeline or activity scope.
 * Payloads live here — not inline under the left tree (Trace contract).
 */

import type { OperationActivity, OperationEvent, OperationPipeline } from "../../client/index"
import { OperationKind, OperationStatus } from "../../client/index"
import { JsonViewer } from "../../components/JsonViewer"
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
  formatPipelineSubtitle,
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

function PipelineOverview({ pipeline }: { pipeline: OperationPipeline }) {
  const subtitle = pipeline.subtitle ? formatPipelineSubtitle(pipeline.subtitle) : null
  const showError = pipeline.error && pipeline.status === OperationStatus.Failed

  return (
    <div className="op-log-scope-detail__body px-4 py-3">
      <p className={`${OP_LOG_MUTED} text-sm leading-relaxed`}>
        Select a step in the tree to inspect payloads, tool I/O, and event data.
      </p>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 review-meta text-text-muted">
        <span>{fmtDuration(pipeline.durationMs)}</span>
        <span>{fmtTime(pipeline.startedAt)}</span>
        <span>
          {pipeline.activityCount} act · {pipeline.eventCount} ev
        </span>
      </div>
      {subtitle ? <p className={`${OP_LOG_MUTED} mt-2 text-sm`}>{subtitle}</p> : null}
      {showError && pipeline.error ? (
        <div className="op-log-detail__error-callout mt-3" title={pipeline.error}>
          <span className="op-log-detail__error-label">Error</span>
          <span className="op-log-detail__error-text">{pipeline.error}</span>
        </div>
      ) : null}
    </div>
  )
}

function EventPayload({ ev }: { ev: OperationEvent }) {
  const toolIo = readToolIoFromEvent(ev)
  if (toolIo) {
    return <ToolIoBlock io={toolIo} compact maxHeight={420} />
  }
  if (isSyncSqlEventType(ev.type)) {
    const fields = readSqlTraceFields(ev.data)
    return (
      <JsonViewer
        value={fields ?? ev.data}
        label="sql"
        defaultExpandDepth={2}
        maxHeight={420}
      />
    )
  }
  if (isSyncHttpEventType(ev.type)) {
    const fields = readHttpTraceFields(ev.data)
    return (
      <JsonViewer
        value={fields ?? ev.data}
        label="http"
        defaultExpandDepth={2}
        maxHeight={420}
      />
    )
  }
  if (ev.data && Object.keys(ev.data).length > 0) {
    return <JsonViewer value={ev.data} label="event" defaultExpandDepth={2} maxHeight={420} />
  }
  return <p className={`${OP_LOG_MUTED} text-sm`}>No payload on this event.</p>
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
    <div className="op-log-scope-detail__body flex min-h-0 flex-col gap-3 px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <h3 className={`min-w-0 flex-1 truncate ${OP_LOG} font-semibold text-text`}>
          {activity.name}
        </h3>
        <OpLogStatusPill status={activity.status} />
      </div>
      {activity.summary ? (
        <p className={`${OP_LOG_MUTED} text-sm`}>{activity.summary}</p>
      ) : null}
      <div className="flex flex-wrap gap-x-4 gap-y-1 review-meta text-text-muted">
        <span>{fmtDuration(activity.durationMs)}</span>
        <span>{fmtTime(activity.startedAt)}</span>
      </div>
      {activity.error ? (
        <div className="op-log-detail__error-callout" title={activity.error}>
          <span className="op-log-detail__error-label">Error</span>
          <span className="op-log-detail__error-text">{activity.error}</span>
        </div>
      ) : null}

      {isAgentTool && toolIo ? <ToolIoBlock io={toolIo} compact maxHeight={420} /> : null}

      {isResultRow && activity.events[0] ? (
        <JsonViewer
          value={activity.events[0].data}
          label="result"
          defaultExpandDepth={2}
          maxHeight={480}
        />
      ) : null}

      {!isResultRow && !isAgentTool && activity.events.length === 0 && activity.details ? (
        isSyncDecisionLogDetails(activity.details) ? (
          <DecisionLogPanel decisions={activity.details.decisions} linear depth={0} />
        ) : toolIo ? (
          <ToolIoBlock io={toolIo} compact maxHeight={420} />
        ) : (
          <JsonViewer
            value={activity.details}
            label="details"
            defaultExpandDepth={2}
            maxHeight={420}
          />
        )
      ) : null}

      {sqlEvents.map((ev, idx) => (
        <EventPayload key={`sql:${idx}`} ev={ev} />
      ))}
      {httpEvents.map((ev, idx) => (
        <EventPayload key={`http:${idx}`} ev={ev} />
      ))}
      {!isResultRow &&
        !isAgentTool &&
        otherEvents.map((ev, idx) => <EventPayload key={`ev:${idx}`} ev={ev} />)}

      {!activity.error &&
      !toolIo &&
      !isResultRow &&
      sqlEvents.length === 0 &&
      httpEvents.length === 0 &&
      otherEvents.length === 0 &&
      !activity.details ? (
        <p className={`${OP_LOG_MUTED} text-sm`}>
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
    return (
      <div className="op-log-detail op-log-detail--empty flex min-h-0 flex-1 flex-col items-center justify-center px-6">
        <p className="text-sm text-text-muted">Select a pipeline run to inspect</p>
      </div>
    )
  }

  if (selection.kind === "pipeline") {
    return <PipelineOverview pipeline={pipeline} />
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
