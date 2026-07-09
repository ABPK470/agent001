import { TOOL_TRACE_ARG } from "@mia/shared-types"

export { TOOL_TRACE_ARG }

export interface ToolTraceContext {
  readonly toolCallId: string
  readonly toolName: string
  readonly iteration: number
  readonly emit?: (entry: Record<string, unknown>) => void
}

export function withToolTraceArgs(
  args: Record<string, unknown>,
  ctx: ToolTraceContext
): Record<string, unknown> {
  return { ...args, [TOOL_TRACE_ARG]: ctx }
}

export function readToolTraceContext(args: Record<string, unknown>): ToolTraceContext | null {
  const value = args[TOOL_TRACE_ARG]
  if (!value || typeof value !== "object") return null
  const candidate = value as Partial<ToolTraceContext>
  if (typeof candidate.toolCallId !== "string") return null
  if (typeof candidate.toolName !== "string") return null
  if (typeof candidate.iteration !== "number") return null
  return {
    toolCallId: candidate.toolCallId,
    toolName: candidate.toolName,
    iteration: candidate.iteration,
    emit: typeof candidate.emit === "function" ? candidate.emit : undefined
  }
}

export function emitToolTrace(
  ctx: ToolTraceContext | null | undefined,
  entry: Record<string, unknown>
): void {
  ctx?.emit?.({
    toolCallId: ctx.toolCallId,
    toolName: ctx.toolName,
    iteration: ctx.iteration,
    ...entry
  })
}
