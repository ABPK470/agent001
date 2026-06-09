import type { ExecuteRunCommand, ExecutionEnvironment } from "../types.js"

export function cleanupExecution(
  command: ExecuteRunCommand,
  env: ExecutionEnvironment | undefined,
  releaseSlot: () => void
): void {
  const { request, runtime } = command
  env?.disposeEventWiring()
  releaseSlot()
  runtime.bus.dispose()
  runtime.orchestrator.pendingInputs.delete(request.runId)
  runtime.orchestrator.activeRuns.delete(request.runId)
}
