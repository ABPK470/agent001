/**
 * Check whether we can finish.
 *
 * Input: a draft final answer (no tool calls this turn).
 * Output named outcomes:
 *   - accept — guards passed; this is the final answer
 *   - reject_and_continue — inject nudge and keep looping
 * Next: finish, or prepareIteration.
 */

import type { AgentConfig, LLMResponse, Message, Tool } from "../../../domain/types/agent-types.js"
import { MessageRole } from "../../../domain/enums/message.js"
import { completionContext, guardCompletion, type AgentLoopState } from "../../loop.js"
import type { AnswerStreamGate } from "../answer-stream-gate.js"
import { assertUnhandled } from "../unhandled-outcome.js"

export type CheckCanFinishResult =
  | { outcome: "accept"; answer: string }
  | { outcome: "reject_and_continue" }

export async function checkCanFinish(input: {
  response: LLMResponse
  messages: Message[]
  iteration: number
  userGoal: string
  state: AgentLoopState
  toolList: Tool[]
  config: {
    completionValidator: AgentConfig["completionValidator"]
    enableAnswerStabilityGuard: boolean
    onPlannerTrace: AgentConfig["onPlannerTrace"]
    onNudge: AgentConfig["onNudge"]
    deferRecoveryHintsUntilCompletionAttempt?: AgentConfig["deferRecoveryHintsUntilCompletionAttempt"]
    maxIterations: number
    verbose: boolean
    signal: AgentConfig["signal"]
    onStep: AgentConfig["onStep"]
    onThinking: AgentConfig["onThinking"]
    onToken: AgentConfig["onToken"]
    onStreamDiscard: AgentConfig["onStreamDiscard"]
    onLlmCall: AgentConfig["onLlmCall"]
    onToolResult: AgentConfig["onToolResult"]
    enablePlanner: boolean
    workspaceRoot: string
    plannerDelegateFn: AgentConfig["plannerDelegateFn"]
    toolKillManager: AgentConfig["toolKillManager"]
    systemPrompt: string
    systemMessages: Message[] | undefined
  }
  answerGate: AnswerStreamGate
}): Promise<CheckCanFinishResult> {
  const { response, messages, iteration, userGoal, state, toolList, config, answerGate } = input
  state.completionAttempted = true

  const guardResult = await guardCompletion(
    completionContext({
      response,
      messages,
      iteration,
      userGoal,
      state,
      toolList,
      config,
      onPlannerTrace: config.onPlannerTrace
    })
  )

  if (guardResult) {
    if (guardResult.finalAnswer) {
      await answerGate.flushApproved(guardResult.finalAnswer)
      return { outcome: "accept", answer: guardResult.finalAnswer }
    }
    answerGate.discard()
    messages.push({
      role: MessageRole.Assistant,
      content: response.content,
      section: "history"
    })
    messages.push({
      role: MessageRole.System,
      content: guardResult.message,
      section: "history",
      hint: true
    })
    config.onNudge?.({
      tag: guardResult.tag,
      message: guardResult.message,
      iteration
    })
    return { outcome: "reject_and_continue" }
  }

  if (!guardResult) {
    const answer = response.content ?? "(no response)"
    await answerGate.flushApproved(answer)
    return { outcome: "accept", answer }
  }

  assertUnhandled("checkCanFinish", { guardResult })
}
