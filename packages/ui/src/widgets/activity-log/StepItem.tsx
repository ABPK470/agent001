import { ChevronRight, Wrench } from "lucide-react"
import { useState } from "react"
import type { OperationActivity, OperationEvent, OperationKind, OperationStatus } from "../../api"
import { isSyncDecisionLogDetails } from "../../components/DecisionLogPanel"
import { JsonViewer } from "../../components/JsonViewer"
import { ToolCallModal, ToolIoBlock } from "../../components/ToolCallModal"
import {
  activityPipelineKind,
  defaultActivitySummary,
  effectiveActivityStatus,
  formatActivityName,
  fmtDuration,
  fmtTime,
  isSqlOnlyActivity,
  isSyncExecuteFlowStep,
  pipelineActivityKey,
  shouldHideSyncExecuteStepEvent,
} from "../../lib/operation-presentation"
import { useOpLogOpenSqlTrace } from "../../operation-log-modals"
import { describeSqlEvent, describeSqlOnlyActivity, formatTraceRowSummary } from "../../operation-log-trace"
import { isSyncSqlEventType } from "../../sync-sql-trace"
import {
  buildToolIoFromStepEvents,
  readToolIoFromActivity,
} from "../../tool-call-io"
import { PreflightChecks } from "./PreflightChecks"
import { ResultPanel, SqlTraceItem, TraceItem } from "./TraceItem"
import { StatusIcon } from "./primitives"
import { AL, statusColorClass } from "./tokens"

function isDuplicateMessage(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a === b
}

export function StepItem({
  activity,
  pipelineKind,
  pipelineId,
  pipelineStatus,
  pipelineError,
  parentStatus,
  parentPhaseId,
  depth,
  expanded,
  onToggle,
  actExpanded,
  toggleActivity,
}: {
  activity: OperationActivity
  pipelineKind: OperationKind
  pipelineId: string
  pipelineStatus: OperationStatus
  pipelineError?: string
  parentStatus?: OperationStatus
  parentPhaseId?: string
  depth: number
  expanded: boolean
  onToggle: () => void
  actExpanded: Set<string>
  toggleActivity: (key: string) => void
}) {
  const [ioOpen, setIoOpen] = useState(false)
  const openSqlTrace = useOpLogOpenSqlTrace()

  const phaseId = activity.id.startsWith("phase:") ? activity.id : parentPhaseId
  const effectiveKind = activityPipelineKind(pipelineKind, phaseId)
  const status = effectiveActivityStatus(activity, pipelineStatus, parentStatus)
  const name = formatActivityName(effectiveKind, activity)
  const summary = defaultActivitySummary(effectiveKind, activity)
  const isResultRow = activity.name === "result"
  const isFlowStep = isSyncExecuteFlowStep(effectiveKind, activity)
  const resultChild = activity.children?.find((c) => c.name === "result")
  const hasChildren = (activity.children?.length ?? 0) > 0
  const hasResultChild = resultChild != null
  const sqlEvents = activity.events.filter((ev) => isSyncSqlEventType(ev.type))
  const visibleEvents = activity.events.filter(
    (ev) => !isSyncSqlEventType(ev.type) && !shouldHideSyncExecuteStepEvent(effectiveKind, activity, ev),
  )
  const statusMessage = isResultRow || hasResultChild ? null : activity.error ?? null
  const toolIo =
    readToolIoFromActivity(activity) ??
    (activity.events.length > 0 ? buildToolIoFromStepEvents(activity.events) : null)

  if (isSqlOnlyActivity(activity)) {
    const trace = describeSqlOnlyActivity(activity)
    const summaryText = formatTraceRowSummary(trace)
    return (
      <SqlTraceItem
        summary={summaryText}
        durationMs={activity.durationMs}
        onOpenSql={() => trace.sqlFields && openSqlTrace(trace.sqlFields)}
      />
    )
  }

  const rowClass = depth === 0 ? AL.rowButton : AL.rowCompactButton

  return (
    <>
      <button type="button" className={rowClass} onClick={onToggle}>
          <ChevronRight
            size={14}
            className={`shrink-0 text-text-faint transition-transform ${expanded ? "rotate-90" : ""}`}
          />
        <StatusIcon status={status} size={16} />
        <span className={`min-w-0 flex-1 truncate ${depth === 0 ? AL.title : "font-medium"} ${statusColorClass(status)}`}>
          {name}
        </span>
        {summary && !isResultRow ? (
          <span className={`hidden min-w-0 max-w-[40%] truncate ${AL.subtitle} lg:inline`}>{summary}</span>
        ) : null}
        <span className={AL.meta}>{fmtDuration(activity.durationMs)}</span>
        <span className={`${AL.meta} w-16 text-right`}>{fmtTime(activity.startedAt)}</span>
        {toolIo && (
          <span
            role="button"
            tabIndex={0}
            className={AL.action}
            onClick={(e) => {
              e.stopPropagation()
              setIoOpen(true)
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.stopPropagation()
                setIoOpen(true)
              }
            }}
          >
            <Wrench size={13} className="inline mr-1" />
            I/O
          </span>
        )}
      </button>

      {expanded && (
        <div className={depth === 0 ? AL.nest : `${AL.nest} ml-[26px]`}>
          {statusMessage && !isDuplicateMessage(pipelineError, statusMessage) && (
            <div className={`${AL.panel} ${statusColorClass(status)}`}>{statusMessage}</div>
          )}

          {isFlowStep &&
            sqlEvents.map((ev, idx) => {
              const trace = describeSqlEvent(ev)
              const resultData = resultChild?.events[0]?.data
              return (
                <div key={`sql-${idx}`}>
                  <SqlTraceItem
                    summary={formatTraceRowSummary(trace)}
                    durationMs={trace.durationMs}
                    onOpenSql={() => trace.sqlFields && openSqlTrace(trace.sqlFields)}
                  />
                  {resultData && typeof resultData === "object" && (
                    <ResultPanel data={resultData} />
                  )}
                </div>
              )
            })}

          {isResultRow && activity.events[0] && <ResultPanel data={activity.events[0].data} />}

          {!isResultRow && activity.events.length === 0 && activity.details && !statusMessage && (
            <>
              {toolIo && <div className={AL.panel}><ToolIoBlock io={toolIo} compact maxHeight={120} /></div>}
              {activity.details && Object.keys(activity.details).length > 0 && !toolIo && (
                isSyncDecisionLogDetails(activity.details) ? (
                  <PreflightChecks decisions={activity.details.decisions} />
                ) : (
                  <div className={AL.panel}>
                    <JsonViewer value={activity.details} label="details" defaultExpandDepth={2} maxHeight={280} />
                  </div>
                )
              )}
            </>
          )}

          {hasChildren &&
            !isResultRow &&
            !hasResultChild &&
            activity.children!.map((child) => {
              const childKey = pipelineActivityKey(pipelineId, child.id)
              return (
                <StepItem
                  key={childKey}
                  activity={child}
                  pipelineKind={pipelineKind}
                  pipelineId={pipelineId}
                  pipelineStatus={pipelineStatus}
                  pipelineError={pipelineError}
                  parentStatus={status}
                  parentPhaseId={phaseId}
                  depth={depth + 1}
                  expanded={actExpanded.has(childKey)}
                  onToggle={() => toggleActivity(childKey)}
                  actExpanded={actExpanded}
                  toggleActivity={toggleActivity}
                />
              )
            })}

          {!isResultRow && activity.events.length > 0 && toolIo && (
            <div className={AL.panel}>
              <ToolIoBlock io={toolIo} compact maxHeight={100} />
            </div>
          )}

          {!isResultRow &&
            !isFlowStep &&
            activity.events.map((ev, idx) => <TraceItem key={idx} ev={ev} />)}

          {isFlowStep &&
            visibleEvents.map((ev, idx) => <TraceItem key={`misc-${idx}`} ev={ev as OperationEvent} />)}
        </div>
      )}

      {ioOpen && toolIo && <ToolCallModal io={toolIo} onClose={() => setIoOpen(false)} />}
    </>
  )
}
