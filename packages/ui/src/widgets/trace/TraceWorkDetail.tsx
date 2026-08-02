/**
 * Work detail — tool runs, SQL validation, error notes.
 */

import type { TraceDag, TraceToolCall, TraceWorkNode } from "./build-trace-dag"
import { callToolOpenKey, workToolOpenKey } from "./open-state"
import { SqlQualityRow } from "./TraceRows"
import { ExpandableText } from "./TraceExpandable"
import { TraceErrorBlock } from "./TraceErrorBlock"
import { TraceToolIo } from "./TraceToolIo"

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

  if (tool) {
    return (
      <div className="trace-detail-body">
        <TraceToolIo
          dag={dag}
          toolName={tool.name}
          argumentsValue={tool.arguments}
          resultText={tool.resultText}
        />
        {tool.status === "error" && tool.resultText ? (
          <TraceErrorBlock text={tool.resultText} title="ERROR" />
        ) : null}
      </div>
    )
  }

  return (
    <div className="trace-detail-body">
      {errorNotes.map((note) => (
        <TraceErrorBlock key={note.id} text={note.text} />
      ))}
      {work.tools.map((t) => (
        <TraceToolIo
          key={t.id}
          dag={dag}
          toolName={t.name}
          argumentsValue={t.arguments}
          resultText={t.resultText}
          label={t.name}
        />
      ))}
      {work.sqlQuality.length > 0 && (
        <div className="trace-detail-section">
          <div className="trace-detail-section__label">SQL validation</div>
          {work.sqlQuality.map((entry, i) => (
            <SqlQualityRow key={`${entry.toolCallId}-${i}`} entry={entry} />
          ))}
        </div>
      )}
      {work.notes
        .filter((n) => n.tone !== "error")
        .map((note) => (
          <div key={note.id} className="trace-detail-section">
            <div className="trace-detail-section__label">{note.label}</div>
            <ExpandableText text={note.text} className="trace-body-muted" />
          </div>
        ))}
    </div>
  )
}
