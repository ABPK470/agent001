/**
 * Tool span detail — structured I/O with schema validation + curl.
 */

import type { TraceDag } from "./build-trace-dag"
import { callToolOpenKey, workToolOpenKey } from "./open-state"
import type { TraceToolCall } from "./build-trace-dag"
import { TraceToolIo } from "./TraceToolIo"

function resolveTool(dag: TraceDag, toolKey: string): TraceToolCall | null {
  for (const call of dag.calls) {
    for (const tool of call.toolBranches) {
      if (callToolOpenKey(call.index, tool.id) === toolKey) return tool
    }
  }
  for (const entry of dag.spine) {
    const works =
      entry.kind === "work"
        ? [entry.work]
        : entry.kind === "phase"
          ? (entry.phase.children ?? [])
              .filter((c): c is Extract<typeof c, { kind: "work" }> => c.kind === "work")
              .map((c) => c.work)
          : []
    for (const work of works) {
      for (const tool of work.tools) {
        if (workToolOpenKey(work.id, tool.id) === toolKey) return tool
      }
    }
  }
  return null
}

function toolCurl(tool: TraceToolCall): string | null {
  if (!tool.name) return null
  return `curl -X POST '/api/tools/${tool.name}' -H 'Content-Type: application/json' -d '${JSON.stringify(tool.arguments)}'`
}

export function TraceToolDetail({
  dag,
  toolKey,
}: {
  dag: TraceDag
  toolKey: string
}) {
  const tool = resolveTool(dag, toolKey)
  if (!tool) {
    return <p className="trace-empty">Tool not found</p>
  }

  const curl = toolCurl(tool)

  return (
    <div className="trace-detail-body">
      <TraceToolIo
        dag={dag}
        toolName={tool.name}
        argumentsValue={tool.arguments}
        resultText={tool.resultText}
      />
      {tool.status === "error" && tool.resultText ? (
        <div className="trace-error-block">
          <div className="trace-error-block__title">ERROR</div>
          <pre className="trace-error-block__trace">{tool.resultText}</pre>
        </div>
      ) : null}
      {curl ? (
        <div className="trace-detail-section">
          <div className="trace-detail-section__label">Copy as curl</div>
          <pre className="trace-detail-curl">{curl}</pre>
        </div>
      ) : null}
    </div>
  )
}
