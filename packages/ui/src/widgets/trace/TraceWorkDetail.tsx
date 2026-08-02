/**
 * Work detail — tool runs, SQL validation, error notes.
 */

import type { TraceDag, TraceToolCall, TraceWorkNode } from "./build-trace-dag"
import { callToolOpenKey, workToolOpenKey } from "./open-state"
import { SqlQualityRow } from "./TraceRows"
import { ExpandableText } from "./TraceExpandable"
import { TraceErrorBlock } from "./TraceErrorBlock"
import { TraceToolIo } from "./TraceToolIo"
import { TraceAskUserInteraction } from "./TraceAskUserInteraction"
import {
  askUserConsumedNoteIds,
  extractAskUserAnswer,
  extractAskUserQuestion,
  isAskUserTool,
} from "./trace-ask-user"

function findWorkTool(
  dag: TraceDag,
  work: TraceWorkNode,
  toolKey: string | null,
): TraceToolCall | null {
  if (!toolKey) return null
  for (const tool of work.tools) {
    if (workToolOpenKey(work.id, tool.id) === toolKey) return tool
  }
  for (const call of dag.calls) {
    for (const tool of call.toolBranches) {
      if (callToolOpenKey(call.index, tool.id) === toolKey) return tool
    }
  }
  return null
}

function AskUserToolDetail({
  dag,
  work,
  tool,
}: {
  dag: TraceDag
  work: TraceWorkNode
  tool: TraceToolCall
}) {
  const isError = tool.status === "error"
  const question = extractAskUserQuestion(tool.arguments, work.notes)
  const answer = isError ? null : extractAskUserAnswer(tool.resultText, work.notes)

  return (
    <>
      <TraceAskUserInteraction question={question} answer={answer} />
      <TraceToolIo
        dag={dag}
        toolName={tool.name}
        argumentsValue={tool.arguments}
        layout="developer"
        hideResult
      />
      {isError && tool.resultText ? (
        <div className="trace-detail-section">
          <div className="trace-detail-section__label">Error</div>
          <TraceErrorBlock text={tool.resultText} title="ERROR / EXCEPTION TRACE" />
        </div>
      ) : null}
    </>
  )
}

function renderWorkTool(
  dag: TraceDag,
  work: TraceWorkNode,
  tool: TraceToolCall,
) {
  if (isAskUserTool(tool)) {
    return <AskUserToolDetail key={tool.id} dag={dag} work={work} tool={tool} />
  }

  const isError = tool.status === "error"
  return (
    <div key={tool.id} className="trace-detail-section">
      <TraceToolIo
        dag={dag}
        toolName={tool.name}
        argumentsValue={tool.arguments}
        resultText={isError ? null : tool.resultText}
      />
      {isError && tool.resultText ? (
        <TraceErrorBlock text={tool.resultText} title="ERROR / EXCEPTION TRACE" />
      ) : null}
    </div>
  )
}

export function TraceWorkDetail({
  work,
  dag,
  toolKey,
}: {
  work: TraceWorkNode
  dag: TraceDag
  toolKey: string | null
}) {
  const tool = findWorkTool(dag, work, toolKey)
  const errorNotes = work.notes.filter((n) => n.tone === "error")
  const consumedNoteIds = askUserConsumedNoteIds(work.notes)
  const otherNotes = work.notes.filter(
    (n) => n.tone !== "error" && !consumedNoteIds.has(n.id),
  )

  if (tool) {
    if (isAskUserTool(tool)) {
      return (
        <div className="trace-detail-body">
          <AskUserToolDetail dag={dag} work={work} tool={tool} />
        </div>
      )
    }

    const isError = tool.status === "error"
    return (
      <div className="trace-detail-body">
        <TraceToolIo
          dag={dag}
          toolName={tool.name}
          argumentsValue={tool.arguments}
          resultText={isError ? null : tool.resultText}
        />
        {isError && tool.resultText ? (
          <div className="trace-detail-section">
            <div className="trace-detail-section__label">Error / result</div>
            <TraceErrorBlock text={tool.resultText} title="ERROR / EXCEPTION TRACE" />
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="trace-detail-body">
      {errorNotes.map((note) => (
        <TraceErrorBlock key={note.id} text={note.text} />
      ))}
      {work.tools.map((t) => renderWorkTool(dag, work, t))}
      {work.sqlQuality.length > 0 && (
        <div className="trace-detail-section">
          <div className="trace-detail-section__label">SQL validation</div>
          {work.sqlQuality.map((entry, i) => (
            <SqlQualityRow key={`${entry.toolCallId}-${i}`} entry={entry} />
          ))}
        </div>
      )}
      {otherNotes.map((note) => (
        <div key={note.id} className="trace-detail-section">
          <div className="trace-detail-section__label">{note.label}</div>
          <ExpandableText text={note.text} className="trace-body-muted" />
        </div>
      ))}
    </div>
  )
}
