import { detectInternalFailure, isPlatformUnconfiguredAnswer, type ExecutableTool } from "@mia/agent"
import { runReflectionTurn } from "../../../core/coordination/run-reflection.js"
import type { ExecuteRunCommand, ExecutionEnvironment } from "../types.js"

function findVerdictTool(tools: ExecutableTool[]): ExecutableTool | undefined {
  return tools.find((tool) => tool.name === "record_table_verdict")
}

export async function maybeRunReflection(
  command: ExecuteRunCommand,
  env: ExecutionEnvironment,
  answer: string
): Promise<void> {
  const { request, runtime } = command
  const internalFailure = detectInternalFailure(answer)
  if (!env.toolDecision.includeDataPersona || isPlatformUnconfiguredAnswer(answer) || !!internalFailure) {
    env.boundSaveTrace(request.runId, {
      kind: "reflection",
      outcome: "gated",
      verdictsRecorded: 0,
      toolResults: [],
      detail:
        `gate: includeDataPersona=${env.toolDecision.includeDataPersona ? 1 : 0} ` +
        `platformUnconfigured=${isPlatformUnconfiguredAnswer(answer) ? 1 : 0} ` +
        `internalFailure=${internalFailure ? 1 : 0}`
    })
    return
  }

  try {
    const verdictTool = findVerdictTool(env.allTools)
    if (!verdictTool) {
      env.boundSaveTrace(request.runId, {
        kind: "reflection",
        outcome: "skipped",
        verdictsRecorded: 0,
        toolResults: [],
        detail: "record_table_verdict tool not bound to this run"
      })
      return
    }

    const reflection = await runReflectionTurn({
      runId: request.runId,
      goal: request.goal,
      answer,
      steps: env.state.run.steps,
      recordVerdictTool: verdictTool,
      llm: runtime.orchestrator.llm,
      signal: runtime.controller.signal
    })
    console.log(
      `[reflection] run=${request.runId} outcome=${reflection.outcome} recorded=${reflection.verdictsRecorded} ${reflection.detail}`
    )
    env.boundSaveTrace(request.runId, {
      kind: "reflection",
      outcome: reflection.outcome,
      verdictsRecorded: reflection.verdictsRecorded,
      toolResults: reflection.toolResults,
      detail: reflection.detail
    })
  } catch (error) {
    console.warn(`[reflection] run=${request.runId} failed: ${(error as Error).message}`)
    env.boundSaveTrace(request.runId, {
      kind: "reflection",
      outcome: "error",
      verdictsRecorded: 0,
      toolResults: [],
      detail: `threw: ${(error as Error).message}`
    })
  }
}
