/**
 * Flatten an operation pipeline into a chronological timeline for the Activity widget.
 */

import type { OperationActivity, OperationEvent, OperationKind, OperationPipeline, OperationStatus } from "../../api"
import { OperationKind as Kind, OperationStatus as Status } from "../../api"
import type { SyncDecisionEntry } from "../../components/DecisionLogPanel"
import { isSyncDecisionLogDetails } from "../../components/DecisionLogPanel"
import {
  activityPipelineKind,
  defaultActivitySummary,
  effectiveActivityStatus,
  formatActivityName,
  formatEventLabel,
  isSqlOnlyActivity,
  isSyncExecuteFlowStep,
  pickEventSummary,
  shouldHideSyncExecuteStepEvent,
} from "../../lib/operation-presentation"
import { describeSqlEvent, describeSqlOnlyActivity, formatTraceRowSummary } from "../../operation-log-trace"
import { isSyncSqlEventType, readSqlTraceFields, type SqlTraceFields } from "../../sync-sql-trace"
import {
  buildToolIoFromStepEvents,
  isAgentStepEventType,
  readToolIoFromActivity,
  readToolIoFromEvent,
} from "../../tool-call-io"
import type { ToolIoDetails } from "../../tool-call-io"

export type TimelineNodeKind = "step" | "sql" | "event" | "preflight" | "message" | "sql-group"

export interface TimelineNode {
  id: string
  kind: TimelineNodeKind
  status: OperationStatus
  title: string
  detail?: string
  timestamp?: string
  durationMs?: number | null
  depth: number
  sqlFields?: SqlTraceFields
  toolIo?: ToolIoDetails
  jsonPayload?: unknown
  /** Preflight decision rows shown inline under one header */
  preflightItems?: SyncDecisionEntry[]
  /** Child SQL lines when kind === sql-group */
  sqlLines?: TimelineNode[]
}

interface WalkCtx {
  pipelineKind: OperationKind
  pipelineId: string
  pipelineStatus: OperationStatus
  parentPhaseId?: string
  parentStatus?: OperationStatus
  depth: number
}

function eventStatus(ev: OperationEvent): OperationStatus {
  if (ev.type.includes(".failed") || ev.data["error"]) return Status.Failed
  if (ev.type.includes(".skipped")) return Status.Skipped
  return Status.Success
}

function sqlNode(id: string, activity: OperationActivity, status: OperationStatus, depth: number): TimelineNode {
  const trace = describeSqlOnlyActivity(activity)
  return {
    id,
    kind: "sql",
    status,
    title: formatTraceRowSummary(trace),
    timestamp: activity.startedAt,
    durationMs: activity.durationMs,
    depth,
    sqlFields: trace.sqlFields,
  }
}

function walkActivity(activity: OperationActivity, ctx: WalkCtx): TimelineNode[] {
  const phaseId = activity.id.startsWith("phase:") ? activity.id : ctx.parentPhaseId
  const effectiveKind = activityPipelineKind(ctx.pipelineKind, phaseId)
  const status = effectiveActivityStatus(activity, ctx.pipelineStatus, ctx.parentStatus)
  const name = formatActivityName(effectiveKind, activity)
  const summary = defaultActivitySummary(effectiveKind, activity)
  const baseId = `${ctx.pipelineId}|${activity.id}`
  const nodes: TimelineNode[] = []

  if (isSqlOnlyActivity(activity)) {
    return [sqlNode(baseId, activity, status, ctx.depth)]
  }

  const isFlowStep = isSyncExecuteFlowStep(effectiveKind, activity)
  const resultChild = activity.children?.find((c) => c.name === "result")
  const sqlEvents = activity.events.filter((ev) => isSyncSqlEventType(ev.type))
  const visibleEvents = activity.events.filter(
    (ev) => !isSyncSqlEventType(ev.type) && !shouldHideSyncExecuteStepEvent(effectiveKind, activity, ev),
  )
  const toolIo =
    readToolIoFromActivity(activity) ??
    (activity.events.length > 0 ? buildToolIoFromStepEvents(activity.events) : null)

  const sqlChildren = activity.children?.filter(isSqlOnlyActivity) ?? []
  const nonSqlChildren = activity.children?.filter((c) => !isSqlOnlyActivity(c)) ?? []

  if (sqlChildren.length > 0 && nonSqlChildren.length === 0 && activity.events.length === 0) {
    const lines = sqlChildren.map((child, i) =>
      sqlNode(`${baseId}|sql:${i}`, child, effectiveActivityStatus(child, ctx.pipelineStatus, status), ctx.depth + 1),
    )
    if (lines.length > 8) {
      nodes.push({
        id: baseId,
        kind: "sql-group",
        status,
        title: name,
        detail: summary ?? `${lines.length} SQL queries`,
        timestamp: activity.startedAt,
        durationMs: activity.durationMs,
        depth: ctx.depth,
        sqlLines: lines,
      })
      return nodes
    }
    nodes.push({
      id: baseId,
      kind: "step",
      status,
      title: name,
      detail: summary,
      timestamp: activity.startedAt,
      durationMs: activity.durationMs,
      depth: ctx.depth,
    })
    nodes.push(...lines)
    return nodes
  }

  nodes.push({
    id: baseId,
    kind: "step",
    status,
    title: name,
    detail: summary,
    timestamp: activity.startedAt,
    durationMs: activity.durationMs,
    depth: ctx.depth,
    toolIo: toolIo ?? undefined,
  })

  if (activity.error && activity.name !== "result") {
    nodes.push({
      id: `${baseId}|err`,
      kind: "message",
      status,
      title: activity.error,
      depth: ctx.depth + 1,
    })
  }

  if (activity.details && isSyncDecisionLogDetails(activity.details)) {
    nodes.push({
      id: `${baseId}|preflight`,
      kind: "preflight",
      status,
      title: "Preflight checks",
      depth: ctx.depth + 1,
      preflightItems: activity.details.decisions,
    })
  } else if (activity.details && Object.keys(activity.details).length > 0 && !toolIo) {
    nodes.push({
      id: `${baseId}|details`,
      kind: "message",
      status,
      title: "Details",
      depth: ctx.depth + 1,
      jsonPayload: activity.details,
    })
  }

  if (isFlowStep) {
    for (let i = 0; i < sqlEvents.length; i++) {
      const ev = sqlEvents[i]!
      const trace = describeSqlEvent(ev)
      nodes.push({
        id: `${baseId}|flow-sql:${i}`,
        kind: "sql",
        status,
        title: formatTraceRowSummary(trace),
        timestamp: ev.timestamp,
        durationMs: trace.durationMs ?? null,
        depth: ctx.depth + 1,
        sqlFields: trace.sqlFields,
      })
      const resultData = resultChild?.events[0]?.data
      if (resultData) {
        nodes.push({
          id: `${baseId}|flow-result:${i}`,
          kind: "message",
          status,
          title: "Result",
          depth: ctx.depth + 2,
          jsonPayload: resultData,
        })
      }
    }
  }

  if (activity.name === "result" && activity.events[0]) {
    nodes.push({
      id: `${baseId}|result`,
      kind: "message",
      status,
      title: "Result",
      depth: ctx.depth + 1,
      jsonPayload: activity.events[0].data,
    })
  }

  const childCtx: WalkCtx = {
    ...ctx,
    parentPhaseId: phaseId,
    parentStatus: status,
    depth: ctx.depth + 1,
  }

  for (const child of nonSqlChildren) {
    if (child.name === "result" && isFlowStep) continue
    nodes.push(...walkActivity(child, childCtx))
  }

  if (!isFlowStep) {
    for (let i = 0; i < visibleEvents.length; i++) {
      const ev = visibleEvents[i]!
      nodes.push(eventNode(`${baseId}|ev:${i}`, ev, ctx.depth + 1))
    }
  } else {
    for (let i = 0; i < visibleEvents.length; i++) {
      nodes.push(eventNode(`${baseId}|misc:${i}`, visibleEvents[i]!, ctx.depth + 1))
    }
  }

  return nodes
}

function eventNode(id: string, ev: OperationEvent, depth: number): TimelineNode {
  const isSql = isSyncSqlEventType(ev.type)
  const isStep = isAgentStepEventType(ev.type)
  const sqlTrace = isSql ? describeSqlEvent(ev) : null
  const summary = isSql && sqlTrace ? formatTraceRowSummary(sqlTrace) : pickEventSummary(ev)
  const label = isSql ? null : formatEventLabel(ev)
  const durationMs = typeof ev.data["durationMs"] === "number" ? ev.data["durationMs"] : null

  return {
    id,
    kind: isSql ? "sql" : "event",
    status: eventStatus(ev),
    title: label ?? summary,
    detail: label ? summary : undefined,
    timestamp: ev.timestamp,
    durationMs,
    depth,
    sqlFields: isSql ? readSqlTraceFields(ev.data) ?? undefined : undefined,
    toolIo: isStep ? readToolIoFromEvent(ev) ?? undefined : undefined,
    jsonPayload: !isSql && !isStep && ev.data && Object.keys(ev.data).length > 0 ? ev.data : undefined,
  }
}

export function buildOperationTimeline(pipeline: OperationPipeline): TimelineNode[] {
  const nodes: TimelineNode[] = []

  if (pipeline.error) {
    nodes.push({
      id: `${pipeline.id}|pipeline-err`,
      kind: "message",
      status: pipeline.status,
      title: pipeline.error,
      depth: 0,
    })
  }

  for (const activity of pipeline.activities) {
    nodes.push(
      ...walkActivity(activity, {
        pipelineKind: pipeline.kind,
        pipelineId: pipeline.id,
        pipelineStatus: pipeline.status,
        depth: 0,
      }),
    )
  }

  return nodes
}

function severityToStatus(severity: string | null | undefined): OperationStatus {
  if (severity === "error") return Status.Failed
  if (severity === "warning") return Status.Skipped
  return Status.Success
}

export function preflightItemStatus(entry: SyncDecisionEntry): OperationStatus {
  return severityToStatus(entry.severity)
}

export const KIND_SHORT: Record<OperationKind, string> = {
  [Kind.AgentRun]: "Agent",
  [Kind.SyncPreview]: "Preview",
  [Kind.SyncExecute]: "Execute",
  [Kind.SyncRun]: "Sync",
  [Kind.ProposerRun]: "Scan",
  [Kind.System]: "System",
}
