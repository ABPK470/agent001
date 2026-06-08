import type { ExecuteRunInput, ExecutionEnvironment } from "../types.js"

export function cleanupExecution(
  input: ExecuteRunInput,
  env: ExecutionEnvironment | undefined,
  releaseSlot: () => void
): void {
  env?.disposeEventWiring()
  releaseSlot()
  input.bus.dispose()
  input.ctx.pendingInputs.delete(input.runId)
  input.ctx.activeRuns.delete(input.runId)
}
