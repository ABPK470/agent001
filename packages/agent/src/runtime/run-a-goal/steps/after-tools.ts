/**
 * After tools.
 *
 * Input: results of the tool round.
 * Output named outcomes:
 *   - answered — hard stop with a final answer
 *   - continue_loop — go to the next iteration
 *   - needs_synthesis — one final no-tool LLM synthesis, then finish
 *   - abort_loop — fatal tool outcome becomes the answer
 * Next: prepareIteration, finish, or synthesis then finish.
 *
 * Recovery hints and stuck detection run here as an explicit chapter —
 * not as a silent side effect of tool execution.
 */

import * as log from "../../../internal/index.js"
import { MessageRole } from "../../../domain/enums/message.js"
import { processPostRound, type PostRoundContext } from "../../loop.js"
import type { RunToolsResult } from "./run-tools.js"
import { assertUnhandled } from "../unhandled-outcome.js"

export type AfterToolsResult =
  | { outcome: "answered"; answer: string }
  | { outcome: "continue_loop" }
  | { outcome: "needs_synthesis" }
  | { outcome: "abort_loop"; answer: string }

export function afterTools(
  toolsResult: RunToolsResult,
  ctx: {
    state: PostRoundContext["state"]
    config: PostRoundContext["config"] & {
      verbose: boolean
      onStreamDiscard?: (() => void) | undefined
    }
    allToolCalls: PostRoundContext["allToolCalls"]
  }
): AfterToolsResult {
  const { response, messages, iteration, roundToolCalls } = toolsResult
  const { state, config, allToolCalls } = ctx

  if (toolsResult.forcedAbortLoopMessage) {
    allToolCalls.push(...roundToolCalls)
    messages.push({
      role: MessageRole.System,
      content: toolsResult.forcedAbortLoopMessage,
      section: "history"
    })
    config.onNudge?.({
      tag: "fatal-tool-outcome",
      message: toolsResult.forcedAbortLoopMessage,
      iteration
    })
    if (config.verbose) log.logError(toolsResult.forcedAbortLoopMessage)
    return { outcome: "abort_loop", answer: toolsResult.forcedAbortLoopMessage }
  }

  if (toolsResult.forcedAbortRoundMessage) {
    allToolCalls.push(...roundToolCalls)
    messages.push({
      role: MessageRole.System,
      content: toolsResult.forcedAbortRoundMessage,
      section: "history"
    })
    config.onNudge?.({
      tag: "abort-round-tool-outcome",
      message: toolsResult.forcedAbortRoundMessage,
      iteration
    })
    if (config.verbose) log.logError(toolsResult.forcedAbortRoundMessage)
    config.onStep?.(messages, iteration)
    return { outcome: "continue_loop" }
  }

  const postRound = processPostRound({
    roundToolCalls,
    response,
    messages,
    state,
    iteration,
    config,
    allToolCalls,
    failuresThisRound: toolsResult.failuresThisRound,
    delegationThisRound: toolsResult.delegationThisRound,
    delegationThisRoundWasReadOnly: toolsResult.delegationThisRoundWasReadOnly
  })

  if (postRound.finalAnswer) {
    if (config.verbose) log.logFinalAnswer(postRound.finalAnswer)
    return { outcome: "answered", answer: postRound.finalAnswer }
  }
  if (postRound.needsSynthesis) {
    return { outcome: "needs_synthesis" }
  }
  if (postRound.shouldContinue || postRound.finalAnswer === undefined) {
    return { outcome: "continue_loop" }
  }
  assertUnhandled("afterTools", postRound)
}
