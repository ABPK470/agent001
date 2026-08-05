/**
 * Parallel subagent fan-out — 2+ subagent steps streaming at once.
 *
 * Used to keep sibling step chips open while the fan-out is live.
 * Host stick-to-bottom stays on for the whole run (Cursor dialect) — do not
 * park the viewport on the first step header.
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
