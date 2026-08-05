/**
 * Work detail — tool runs, SQL validation, error notes.
 */

import type { ReactNode } from "react"
import { formatMs } from "../../lib/util"
import type { TraceDag, TraceToolCall, TraceWorkNode } from "./build-trace-dag"
import { callToolOpenKey, workToolOpenKey } from "./open-state"
import { SqlQualityRow } from "./TraceRows"
import { ExpandableText } from "./TraceExpandable"
import { TraceToolErrorSection, TraceToolIo, TraceToolSection } from "./TraceToolIo"
import { TraceAskUserInteraction } from "./TraceAskUserInteraction"
import {
  askUserConsumedNoteIds,
  extractAskUserAnswer,
  extractAskUserQuestion,
  isAskUserTool,
} from "./trace-ask-user"
import { statusFromToolCall } from "./trace-tool-exec"

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

function SqlValidationBlock({
  work,
  hideSqlPreview = false,
}: {
  work: TraceWorkNode
  hideSqlPreview?: boolean
}) {
  if (work.sqlQuality.length === 0) return null
  const durationMs = work.sqlQuality.reduce(
    (max, entry) => Math.max(max, entry.durationMs ?? 0),
    0,
  )
  return (
    <TraceToolSection
      label="SQL validation"
      meta={durationMs > 0 ? formatMs(durationMs) : null}
    >
      {work.sqlQuality.map((entry, i) => (
        <SqlQualityRow
          key={`${entry.toolCallId}-${i}`}
          entry={entry}
          hideSqlPreview={hideSqlPreview}
        />
      ))}
    </TraceToolSection>
  )
}

function AskUserToolDetail({
  dag,
  work,
  tool,
  trailing,
}: {
  dag: TraceDag
  work: TraceWorkNode
  tool: TraceToolCall
  trailing?: React.ReactNode
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
        argsFormatted={tool.argsFormatted}
        layout="developer"
        hideResult
        status={statusFromToolCall(tool)}
        durationMs={work.durationMs}
        errorText={isError ? tool.resultText : null}
        trailing={trailing}
      />
    </>
  )
}

function renderWorkTool(
  dag: TraceDag,
  work: TraceWorkNode,
  tool: TraceToolCall,
  trailing: ReactNode,
) {
  if (isAskUserTool(tool)) {
    return (
      <AskUserToolDetail
        key={tool.id}
        dag={dag}
        work={work}
        tool={tool}
        trailing={trailing}
      />
    )
  }

  const isError = tool.status === "error"
  return (
    <div key={tool.id} className="trace-detail-section">
      <TraceToolIo
        dag={dag}
        toolName={tool.name}
        argumentsValue={tool.arguments}
        argsFormatted={tool.argsFormatted}
        resultText={isError ? null : tool.resultText}
        errorText={isError ? tool.resultText : null}
        status={statusFromToolCall(tool)}
        durationMs={work.durationMs}
        trailing={trailing}
      />
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
  const cancelNotes = work.notes.filter((n) => n.tone === "cancelled")
  const pauseNotes = work.notes.filter((n) => n.label === "Paused")
  const consumedNoteIds = askUserConsumedNoteIds(work.notes)
  const otherNotes = work.notes.filter(
    (n) =>
      n.tone !== "error" &&
      n.tone !== "cancelled" &&
      n.label !== "Paused" &&
      !consumedNoteIds.has(n.id),
  )

  if (tool) {
    if (isAskUserTool(tool)) {
      return (
        <div className="trace-detail-body">
          <AskUserToolDetail
            dag={dag}
            work={work}
            tool={tool}
            trailing={<SqlValidationBlock work={work} hideSqlPreview />}
          />
        </div>
      )
    }

    const isError = tool.status === "error"
    // Headline is already Tool: name when toolKey is set — flat pane, not Executed card.
    return (
      <div className="trace-detail-body">
        <TraceToolIo
          dag={dag}
          toolName={tool.name}
          argumentsValue={tool.arguments}
          argsFormatted={tool.argsFormatted}
          resultText={isError ? null : tool.resultText}
          errorText={isError ? tool.resultText : null}
          status={statusFromToolCall(tool)}
          durationMs={work.durationMs}
          layout="pane"
          trailing={<SqlValidationBlock work={work} hideSqlPreview />}
        />
      </div>
    )
  }

  return (
    <div className="trace-detail-body">
      {pauseNotes.map((note) => (
        <div key={note.id} className="trace-detail-section">
          <div className="trace-detail-section__label">Paused</div>
          <ExpandableText text={note.text} className="trace-body-muted" />
        </div>
      ))}
      {cancelNotes.map((note) => (
        <div key={note.id} className="trace-detail-section">
          <div className="trace-detail-section__label">Cancelled</div>
          <ExpandableText text={note.text} className="trace-body-muted" />
        </div>
      ))}
      {errorNotes.map((note) => (
        <TraceToolErrorSection key={note.id} text={note.text} />
      ))}
      {work.tools.map((t, i) =>
        renderWorkTool(
          dag,
          work,
          t,
          i === work.tools.length - 1 ? (
            <SqlValidationBlock work={work} hideSqlPreview />
          ) : null,
        ),
      )}
      {work.tools.length === 0 ? <SqlValidationBlock work={work} /> : null}
      {otherNotes.map((note) => (
        <div key={note.id} className="trace-detail-section">
          <div className="trace-detail-section__label">{note.label}</div>
          <ExpandableText text={note.text} className="trace-body-muted" />
        </div>
      ))}
    </div>
  )
}
