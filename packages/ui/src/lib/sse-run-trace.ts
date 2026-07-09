import type { TraceEntry } from "../types"
import { presentToolCall, readSseStepId, serializeToolCallArgs } from "@mia/shared-types"

export function traceEntryFromStepStarted(
  data: Record<string, unknown>,
): TraceEntry | null {
  const stepId = readSseStepId(data)
  if (!stepId) return null
  const toolName = (data["action"] as string) ?? "unknown"
  const input = (data["input"] as Record<string, unknown>) ?? {}
  const { summary: argsSummary } = presentToolCall(toolName, input)
  const argsFormatted = serializeToolCallArgs(input)
  return {
    kind: "tool-call",
    invocationId: stepId,
    toolCallId: null,
    tool: toolName,
    argsSummary,
    argsFormatted,
  }
}

export function traceEntryFromStepCompleted(data: Record<string, unknown>): TraceEntry | null {
  const stepId = readSseStepId(data)
  if (!stepId) return null
  const output = (data["output"] as Record<string, unknown>) ?? {}
  const result =
    (output["result"] as string) ?? (Object.keys(output).length > 0 ? JSON.stringify(output) : "done")
  return { kind: "tool-result", invocationId: stepId, text: result }
}

export function traceEntryFromStepFailed(data: Record<string, unknown>): TraceEntry | null {
  const stepId = readSseStepId(data)
  if (!stepId) return null
  const errText = (data["error"] as string) ?? "unknown error"
  return { kind: "tool-error", invocationId: stepId, text: errText }
}
