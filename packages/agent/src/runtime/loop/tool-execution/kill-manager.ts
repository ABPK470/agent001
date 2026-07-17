/**
 * `executeWithKillManager` — race a tool execution against the
 * registered killManager so users can interrupt long-running tools
 * (run_command, query_mssql) from the UI.
 *
 * @module
 */

import type { AgentConfig, Tool, ToolResultEnvelope } from "../../../../domain/agent-types.js"
import { executeToolWithTimeout } from "../../../../tools/index.js"
import { withToolTraceArgs } from "./trace-context.js"

export async function executeWithKillManager(
  call: { id: string; name: string; arguments: Record<string, unknown> },
  tool: Tool,
  config: {
    signal: AgentConfig["signal"]
    toolKillManager: AgentConfig["toolKillManager"]
    onPlannerTrace?: AgentConfig["onPlannerTrace"]
    iteration: number
  }
): Promise<{
  result: Awaited<ReturnType<typeof executeToolWithTimeout>>
  killed: boolean
  killMessage: string
}> {
  const killManager = config.toolKillManager
  const killPromise = killManager?.register(call.id, call.name)

  const runExecute = (a: Record<string, unknown>): Promise<string | ToolResultEnvelope> => {
    const tracedArgs = withToolTraceArgs(a, {
      toolCallId: call.id,
      toolName: call.name,
      iteration: config.iteration,
      emit: config.onPlannerTrace
    })
    return killManager?.wrap
      ? killManager.wrap(call.id, () => tool.execute(tracedArgs))
      : tool.execute(tracedArgs)
  }

  if (killPromise) {
    const raceResult = await Promise.race([
      executeToolWithTimeout(call.name, call.arguments, runExecute, {
        toolCallTimeoutMs: 0,
        maxRetries: 1,
        signal: config.signal
      }).then((r) => ({ kind: "exec" as const, value: r })),
      killPromise.then((msg: string) => ({ kind: "kill" as const, value: msg }))
    ])
    killManager!.unregister(call.id)

    if (raceResult.kind === "kill") {
      return {
        result: {
          result: "",
          isError: true,
          timedOut: false,
          retryCount: 0,
          toolFailed: false,
          durationMs: 0
        },
        killed: true,
        killMessage: raceResult.value
      }
    }
    return { result: raceResult.value, killed: false, killMessage: "" }
  }

  const result = await executeToolWithTimeout(call.name, call.arguments, runExecute, {
    toolCallTimeoutMs: 0,
    maxRetries: 1,
    signal: config.signal
  })
  return { result, killed: false, killMessage: "" }
}
