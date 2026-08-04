/**
 * Tool span detail — structured I/O with schema validation; errors in callout only.
 */

import type { TraceDag } from "./build-trace-dag"
import { TraceToolIo } from "./TraceToolIo"
import { TraceAskUserInteraction } from "./TraceAskUserInteraction"
import {
  extractAskUserAnswer,
  extractAskUserQuestion,
  isAskUserTool,
} from "./trace-ask-user"
import { resolveTraceTool, resolveTraceWorkForTool } from "./trace-tool-resolve"
import { statusFromToolCall } from "./trace-tool-exec"

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
  const work = resolveTraceWorkForTool(dag, toolKey)
  const notes = work?.notes ?? []

  if (isAskUserTool(tool)) {
    const question = extractAskUserQuestion(tool.arguments, notes)
    const answer = isError ? null : extractAskUserAnswer(tool.resultText, notes)

    return (
      <div className="trace-detail-body">
        <TraceAskUserInteraction question={question} answer={answer} />
        <TraceToolIo
          dag={dag}
          toolName={tool.name}
          argumentsValue={tool.arguments}
          argsFormatted={tool.argsFormatted}
          layout="developer"
          hideResult
          status={statusFromToolCall(tool)}
          durationMs={work?.durationMs ?? null}
          errorText={isError ? tool.resultText : null}
        />
      </div>
    )
  }

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
        durationMs={work?.durationMs ?? null}
      />
    </div>
  )
}
