import { ApprovalRequiredError } from "@mia/agent"
import { createChildUsageReporter, createRunAgent, normalizeRunAnswer } from "./run-executor/agent.js"
import { prepareExecutionEnvironment } from "./run-executor/environment.js"
import {
  cleanupExecution,
  finalizeCancelledRun,
  finalizeCompletedRun,
  finalizeFailedRun,
  finalizeWaitingForApprovalRun,
  maybeRunReflection
} from "./run-executor/finalization.js"
import { acquireRunSlot } from "./run-executor/support.js"
import type { ExecuteRunCommand, ExecutionEnvironment } from "./run-executor/types.js"

export async function executeRunImpl(command: ExecuteRunCommand): Promise<void> {
  const { request, runtime } = command
  const releaseSlot = await acquireRunSlot(command)
  if (!releaseSlot) return

  let env: ExecutionEnvironment | undefined
  let agent: ReturnType<typeof createRunAgent> | undefined
  const reportChildUsage = createChildUsageReporter(request.runId, () => agent ?? null)

  try {
    env = await prepareExecutionEnvironment(command, reportChildUsage)
    agent = createRunAgent(command, env)

    await env.markRunStarted()
    const rawAnswer = await agent.run(
      request.goal,
      request.resume ? { messages: request.resume.messages, iteration: request.resume.iteration } : undefined
    )
    const answer = await normalizeRunAnswer(command, env, rawAnswer)

    if (runtime.controller.signal.aborted) {
      await finalizeCancelledRun(command, env, agent)
      return
    }

    await maybeRunReflection(command, env, answer)
    await finalizeCompletedRun(command, env, agent, answer)
  } catch (error) {
    if (error instanceof ApprovalRequiredError && env && agent) {
      await finalizeWaitingForApprovalRun(command, env, agent, error)
      return
    }
    if (env && agent) {
      await finalizeFailedRun(command, env, agent, error)
      return
    }
    throw error
  } finally {
    cleanupExecution(command, env, releaseSlot)
  }
}
