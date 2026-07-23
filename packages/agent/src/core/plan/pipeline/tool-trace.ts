/**
 * Emit standard tool-call / tool-result traces for deterministic pipeline
 * steps so chat nests I/O under the step (same dialect as the tool loop).
 *
 * @module
 */

import { randomUUID } from "node:crypto"
import { presentToolCall, serializeToolCallArgs } from "@mia/shared-types"

export type PipelineTraceEmit = (entry: Record<string, unknown>) => void

type ToolExecFn = (toolName: string, args: Record<string, unknown>) => Promise<string>

/**
 * Wrap a tool executor so each invocation emits tool-call then
 * tool-result/tool-error, stamped with the planner stepName for UI nesting.
 */
export function withDeterministicToolTrace(
  toolExecFn: ToolExecFn,
  stepName: string,
  onTrace: PipelineTraceEmit | undefined
): ToolExecFn {
  if (!onTrace) return toolExecFn

  return async (toolName, args) => {
    const invocationId = randomUUID()
    const toolCallId = `det-${stepName}-${invocationId.slice(0, 8)}`
    const { summary: argsSummary } = presentToolCall(toolName, args)
    const argsFormatted = serializeToolCallArgs(args)

    onTrace({
      kind: "tool-call",
      invocationId,
      toolCallId,
      tool: toolName,
      argsSummary,
      argsFormatted,
      stepName
    })

    try {
      const text = await toolExecFn(toolName, args)
      const isError = text.startsWith("Error:")
      onTrace({
        kind: isError ? "tool-error" : "tool-result",
        invocationId,
        toolCallId,
        text
      })
      return text
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      onTrace({
        kind: "tool-error",
        invocationId,
        toolCallId,
        text
      })
      throw err
    }
  }
}
