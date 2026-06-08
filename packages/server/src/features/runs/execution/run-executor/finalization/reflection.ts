import { detectInternalFailure, isPlatformUnconfiguredAnswer, type ExecutableTool } from "@mia/agent"
import { runReflectionTurn } from "../../../core/coordination/run-reflection.js"
import type { ExecuteRunInput, ExecutionEnvironment } from "../types.js"

function findVerdictTool(tools: ExecutableTool[]): ExecutableTool | undefined {
  return tools.find((tool) => tool.name === "record_table_verdict")
}

export async function maybeRunReflection(
  input: ExecuteRunInput,
  env: ExecutionEnvironment,
  answer: string
): Promise<void> {
  const internalFailure = detectInternalFailure(answer)
  if (!env.toolDecision.includeDataPersona || isPlatformUnconfiguredAnswer(answer) || !!internalFailure) {
    env.boundSaveTrace(input.runId, {
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
      env.boundSaveTrace(input.runId, {
        kind: "reflection",
        outcome: "skipped",
        verdictsRecorded: 0,
        toolResults: [],
        detail: "record_table_verdict tool not bound to this run"
      })
      return
    }

    const reflection = await runReflectionTurn({
      runId: input.runId,
      goal: input.goal,
      answer,
      steps: env.state.run.steps,
      recordVerdictTool: verdictTool,
      llm: input.ctx.llm,
      signal: input.controller.signal
    })
    console.log(
      `[reflection] run=${input.runId} outcome=${reflection.outcome} recorded=${reflection.verdictsRecorded} ${reflection.detail}`
    )
    env.boundSaveTrace(input.runId, {
      kind: "reflection",
      outcome: reflection.outcome,
      verdictsRecorded: reflection.verdictsRecorded,
      toolResults: reflection.toolResults,
      detail: reflection.detail
    })
  } catch (error) {
    console.warn(`[reflection] run=${input.runId} failed: ${(error as Error).message}`)
    env.boundSaveTrace(input.runId, {
      kind: "reflection",
      outcome: "error",
      verdictsRecorded: 0,
      toolResults: [],
      detail: `threw: ${(error as Error).message}`
    })
  }
}
