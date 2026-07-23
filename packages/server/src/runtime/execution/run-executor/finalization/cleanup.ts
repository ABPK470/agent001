import type { ExecuteRunCommand, ExecutionEnvironment } from "../types.js"

export function cleanupExecution(
  command: ExecuteRunCommand,
  env: ExecutionEnvironment | undefined,
  releaseSlot: () => void
): void {
  const { request, runtime } = command
  env?.disposeEventWiring()
  releaseSlot()
  runtime.messaging.dispose()
  runtime.interaction.clearPendingInput(request.runId)
  runtime.registry.removeActiveRun(request.runId)
}
