import type { ToolCallRecord } from "../../../tools/_shared/result.js"
import type { ChildExecutionResult } from "../types.js"

export function asToolCallRecords(
  toolCalls: readonly unknown[] | undefined
): readonly ToolCallRecord[] | undefined {
  if (toolCalls == null) return undefined
  return toolCalls as readonly ToolCallRecord[]
}

export function asChildExecution(execution: unknown): ChildExecutionResult | undefined {
  return execution as ChildExecutionResult | undefined
}
