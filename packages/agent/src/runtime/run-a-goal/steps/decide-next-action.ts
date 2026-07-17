/**
 * Decide the next action after the model responds.
 *
 * Input: LLM response for this turn.
 * Output named outcomes:
 *   - finish_check — no tool calls; run completion guards
 *   - run_tools — model requested tool calls
 *   - stop — reserved (not used today; kept for an explicit stop branch)
 * Next: checkCanFinish or runTools.
 */

import type { LLMResponse } from "../../../domain/types/agent-types.js"
import { assertUnhandled } from "../unhandled-outcome.js"

export type NextActionResult =
  | { outcome: "finish_check"; response: LLMResponse }
  | { outcome: "run_tools"; response: LLMResponse }
  | { outcome: "stop"; reason: string }

export function decideNextAction(response: LLMResponse): NextActionResult {
  if (response.toolCalls.length === 0) {
    return { outcome: "finish_check", response }
  }
  if (response.toolCalls.length > 0) {
    return { outcome: "run_tools", response }
  }
  assertUnhandled("decideNextAction", { response })
}
