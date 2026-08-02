/**
 * Tool span detail — structured I/O with schema validation; errors in callout only.
 */

import type { TraceDag } from "./build-trace-dag"
import { TraceErrorBlock } from "./TraceErrorBlock"
import { TraceToolIo } from "./TraceToolIo"
import { resolveTraceTool } from "./trace-tool-resolve"

export function TraceToolDetail({
  dag,
  toolKey,
}: {
  dag: TraceDag
  toolKey: string
}) {
  const tool = resolveTraceTool(dag, toolKey)
  if (!tool) {
    return <p className="trace-empty">Tool not found</p>
  }

  const isError = tool.status === "error"

  return (
    <div className="trace-detail-body">
      <TraceToolIo
        dag={dag}
        toolName={tool.name}
        argumentsValue={tool.arguments}
        resultText={isError ? null : tool.resultText}
        resultLabel={isError ? undefined : "Result"}
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
