/**
 * Tool-call iteration branch — runs a tool round + post-round handling.
 * Extracted from agent.ts.
 *
 * @module
 */

import { MessageRole } from "../../../domain/enums/message.js"
import * as log from "../../../logger.js"
import type { ToolCallRecord } from "../../../tools/index.js"
import type { Message, Tool } from "../../../types.js"
import type { AgentLoopState } from "../loop.js"
import { executeToolRound, processPostRound, type PostRoundContext, type ToolExecContext } from "../loop.js"

export interface ToolCallsBranchInput {
  response: { content: string | null; toolCalls: readonly { name: string }[] }
  messages: Message[]
  iteration: number
  state: AgentLoopState
  tools: Map<string, Tool>
  toolList: Tool[]
  config: ToolExecContext["config"] & PostRoundContext["config"] & {
    verbose: boolean
    onStreamDiscard?: (() => void) | undefined
  }
  allToolCalls: ToolCallRecord[]
}

export interface ToolCallsBranchResult {
  /** If set, exit the run() loop with this final answer. */
  finalAnswer?: string
  /** If true, continue to next iteration. */
  shouldContinue?: boolean
  /** If true, caller must call synthesizeFinalAnswer and return it. */
  needsSynthesis?: boolean
}

export async function executeToolCallsBranch(
  input: ToolCallsBranchInput,
): Promise<ToolCallsBranchResult> {
  const { response, messages, iteration: i, state, tools, toolList, config, allToolCalls } = input

  // This iteration was intermediate — discard the buffered tokens.
  config.onStreamDiscard?.()
  messages.push({
    role: MessageRole.Assistant,
    content: response.content,
    toolCalls: response.toolCalls as Message["toolCalls"],
    section: "history",
  })

  const roundResult = await executeToolRound(
    response.toolCalls as Array<{ id: string; name: string; arguments: Record<string, unknown> & { __parseError?: boolean; __raw?: string } }>,
    {
      tools, toolList,
      state, messages,
      config,
      iteration: i,
      allToolCalls,
    },
  )

  if (roundResult.forcedAbortLoopMessage) {
    allToolCalls.push(...roundResult.roundToolCalls)
    messages.push({ role: MessageRole.System, content: roundResult.forcedAbortLoopMessage, section: "history" })
    config.onNudge?.({ tag: "fatal-tool-outcome", message: roundResult.forcedAbortLoopMessage, iteration: i })
    if (config.verbose) log.logError(roundResult.forcedAbortLoopMessage)
    return { finalAnswer: roundResult.forcedAbortLoopMessage }
  }

  if (roundResult.forcedAbortRoundMessage) {
    allToolCalls.push(...roundResult.roundToolCalls)
    messages.push({ role: MessageRole.System, content: roundResult.forcedAbortRoundMessage, section: "history" })
    config.onNudge?.({ tag: "abort-round-tool-outcome", message: roundResult.forcedAbortRoundMessage, iteration: i })
    if (config.verbose) log.logError(roundResult.forcedAbortRoundMessage)
    config.onStep?.(messages, i)
    return { shouldContinue: true }
  }

  const postRound = processPostRound({
    roundToolCalls: roundResult.roundToolCalls,
    response,
    messages, state,
    iteration: i,
    config,
    allToolCalls,
    failuresThisRound: roundResult.failuresThisRound,
    delegationThisRound: roundResult.delegationThisRound,
    delegationThisRoundWasReadOnly: roundResult.delegationThisRoundWasReadOnly,
  })

  if (postRound.finalAnswer) {
    if (config.verbose) log.logFinalAnswer(postRound.finalAnswer)
    return { finalAnswer: postRound.finalAnswer }
  }

  if (postRound.needsSynthesis) return { needsSynthesis: true }

  return {}
}
