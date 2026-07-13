import { Database, Wrench } from "lucide-react"
import { useState } from "react"
import type { OperationEvent } from "../../api"
import { CodeBlock } from "../../components/CodeBlock"
import { JsonViewer } from "../../components/JsonViewer"
import { ToolCallModal } from "../../components/ToolCallModal"
import { formatEventLabel, pickEventSummary } from "../../lib/operation-presentation"
import { useOpLogOpenSqlTrace } from "../../operation-log-modals"
import { describeSqlEvent, formatTraceRowSummary } from "../../operation-log-trace"
import { isSyncSqlEventType, readSqlTraceFields } from "../../sync-sql-trace"
import {
  isAgentStepEventType,
  readToolIoFromEvent,
  stripToolIoForInlineDisplay,
} from "../../tool-call-io"
import { AL } from "./tokens"

export function TraceItem({ ev }: { ev: OperationEvent }) {
  const openSqlTrace = useOpLogOpenSqlTrace()
  const [expanded, setExpanded] = useState(false)
  const [ioOpen, setIoOpen] = useState(false)

  const isSql = isSyncSqlEventType(ev.type)
  const isStep = isAgentStepEventType(ev.type)
  const sqlFields = isSql ? readSqlTraceFields(ev.data) : null
  const sqlTrace = isSql ? describeSqlEvent(ev) : null
  const toolIo = isStep ? readToolIoFromEvent(ev) : null
  const summary = isSql && sqlTrace ? formatTraceRowSummary(sqlTrace) : pickEventSummary(ev)
  const label = isSql ? null : formatEventLabel(ev)
  const displayData = isStep ? stripToolIoForInlineDisplay(ev.data) : ev.data
  const hasData = displayData && Object.keys(displayData).length > 0
  const isFailed = ev.type.includes(".failed") || !!ev.data["error"]
  const isSkipped = ev.type.includes(".skipped")
  const tone = isFailed ? "text-error" : isSkipped ? "text-warning" : "text-text-secondary"
  const durationMs = typeof ev.data["durationMs"] === "number" ? ev.data["durationMs"] : null

  return (
    <>
      <div className={AL.rowCompact}>
        <span className="w-4 shrink-0" />
        {hasData && !isSql ? (
          <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => setExpanded((v) => !v)}>
            <span className={`font-medium ${tone}`}>{label ?? summary}</span>
            {label && summary ? <span className={`${AL.subtitle} ml-1.5`}>{summary}</span> : null}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate">
            <span className={`font-medium ${tone}`}>{label ?? summary}</span>
            {label && summary ? <span className={`${AL.subtitle} ml-1.5`}>{summary}</span> : null}
          </span>
        )}
        {durationMs != null ? <span className={AL.meta}>{durationMs}ms</span> : null}
        {isSql && sqlFields && (
          <button type="button" className={AL.actionVisible} onClick={() => openSqlTrace(sqlFields)}>
            <Database size={11} className="inline mr-0.5" />
            SQL
          </button>
        )}
        {isStep && toolIo && (
          <button type="button" className={AL.actionVisible} onClick={() => setIoOpen(true)}>
            <Wrench size={11} className="inline mr-0.5" />
            I/O
          </button>
        )}
      </div>
      {expanded && hasData && !isSql && (
        <div className={AL.panel}>
          <JsonViewer value={displayData} label="event" defaultExpandDepth={3} maxHeight={360} />
        </div>
      )}
      {ioOpen && toolIo && <ToolCallModal io={toolIo} onClose={() => setIoOpen(false)} />}
    </>
  )
}

export function SqlTraceItem({
  summary,
  durationMs,
  onOpenSql,
}: {
  summary: string
  durationMs?: number | null
  onOpenSql: () => void
}) {
  return (
    <div className={AL.rowCompact}>
      <span className="w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-text-secondary">{summary}</span>
      {durationMs != null ? <span className={AL.meta}>{durationMs}ms</span> : null}
      <button type="button" className={AL.actionVisible} onClick={onOpenSql}>
        <Database size={11} className="inline mr-0.5" />
        SQL
      </button>
    </div>
  )
}

export function ResultPanel({ data }: { data: unknown }) {
  return (
    <div className={AL.panel}>
      <CodeBlock code={JSON.stringify(data, null, 2)} lang="json" maxHeight={480} />
    </div>
  )
}
