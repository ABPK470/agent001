/**
 * Parallel subagent fan-out — when 2+ subagent steps are live, the transcript
 * host must not stick-to-bottom (that buries earlier sibling step rows).
 *
 * Do not park the host on the first step when fan-out starts: a watching user
 * at the bottom would be yanked to a fixed header every planner parallel run.
 * Pausing follow (`followWhen: !fanOut`) is enough — viewport stays put.
 */

import type { ResponsePart } from "../../lib/events/build-chat-parts"

/** How many subagent step-blocks are currently streaming tools. */
export function countRunningSubagentSteps(parts: ResponsePart[]): number {
  let n = 0
  for (const part of parts) {
    if (part.kind === "step-block" && part.subagent && part.hasRunning) n += 1
  }
  return n
}

export function isParallelSubagentFanOut(parts: ResponsePart[]): boolean {
  return countRunningSubagentSteps(parts) >= 2
}

/** First live subagent step id (document order). */
export function firstRunningSubagentStepId(parts: ResponsePart[]): string | null {
  for (const part of parts) {
    if (part.kind === "step-block" && part.subagent && part.hasRunning) return part.id
  }
  return null
}
