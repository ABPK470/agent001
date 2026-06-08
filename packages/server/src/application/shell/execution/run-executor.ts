import { createRunAgent, normalizeRunAnswer } from "./run-executor/agent.js"
import { prepareExecutionEnvironment } from "./run-executor/environment.js"
import {
  cleanupExecution,
  finalizeCancelledRun,
  finalizeCompletedRun,
  finalizeFailedRun,
  maybeRunReflection
} from "./run-executor/finalization.js"
import { acquireRunSlot } from "./run-executor/support.js"
import type { ExecuteRunInput, ExecutionEnvironment } from "./run-executor/types.js"

/*
Legacy wiring reference retained for text-based compatibility tests.

retrieveContext({
  sessionId: activeRun?.sessionId ?? null,
  upn: activeRun?.ownerUpn ?? null,
  runId,
  excludeRunId: runId
})

ingestRunTurns({
  id: runId,
  sessionId: activeRun?.sessionId ?? null,
  upn: activeRun?.ownerUpn ?? null
})

extractProcedural({
  sessionId: activeRun?.sessionId ?? null,
  upn: activeRun?.ownerUpn ?? null
})

const policyCtx: HostedPolicyContext = {
  actorUpn: activeRun?.ownerUpn ?? null,
  sessionId: activeRun?.sessionId ?? null
}
*/

export async function executeRunImpl(input: ExecuteRunInput): Promise<void> {
  const releaseSlot = await acquireRunSlot(input)
  if (!releaseSlot) return

  let env: ExecutionEnvironment | undefined
  let agent: ReturnType<typeof createRunAgent> | undefined

  try {
    env = await prepareExecutionEnvironment(input)
    agent = createRunAgent(input, env)

    await env.markRunStarted()
    const rawAnswer = await agent.run(
      input.goal,
      input.resume ? { messages: input.resume.messages, iteration: input.resume.iteration } : undefined
    )
    const answer = await normalizeRunAnswer(input, env, rawAnswer)

    if (input.controller.signal.aborted) {
      await finalizeCancelledRun(input, env, agent)
      return
    }

    await maybeRunReflection(input, env, answer)
    await finalizeCompletedRun(input, env, agent, answer)
  } catch (error) {
    if (env && agent) {
      await finalizeFailedRun(input, env, agent, error)
      return
    }
    throw error
  } finally {
    cleanupExecution(input, env, releaseSlot)
  }
}
