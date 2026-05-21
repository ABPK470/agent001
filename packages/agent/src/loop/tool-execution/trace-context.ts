import { AsyncLocalStorage } from "node:async_hooks"

export interface ToolTraceContext {
  readonly toolCallId: string
  readonly toolName: string
  readonly iteration: number
  readonly emit?: (entry: Record<string, unknown>) => void
}

const toolTraceAls = new AsyncLocalStorage<ToolTraceContext>()

export function runWithToolTraceContext<T>(ctx: ToolTraceContext, fn: () => Promise<T>): Promise<T> {
  return toolTraceAls.run(ctx, fn)
}

export function getToolTraceContext(): ToolTraceContext | undefined {
  return toolTraceAls.getStore()
}

export function emitCurrentToolTrace(entry: Record<string, unknown>): void {
  const ctx = toolTraceAls.getStore()
  ctx?.emit?.({
    toolCallId: ctx.toolCallId,
    toolName: ctx.toolName,
    iteration: ctx.iteration,
    ...entry,
  })
}