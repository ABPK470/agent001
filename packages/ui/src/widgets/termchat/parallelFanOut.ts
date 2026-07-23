/**
 * Parallel subagent fan-out — when 2+ subagent steps are live, the transcript
 * host must not stick-to-bottom (that buries earlier sibling step rows).
 */

import type { ResponsePart } from "../../lib/events/build-chat-parts"
import { offsetInScrollHost } from "../../lib/chatScroll"

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

/** First live subagent step id (document order) — align viewport to this header. */
export function firstRunningSubagentStepId(parts: ResponsePart[]): string | null {
  for (const part of parts) {
    if (part.kind === "step-block" && part.subagent && part.hasRunning) return part.id
  }
  return null
}

/**
 * Park the scroll host so `stepEl` sits near the top inset — Plan + sibling
 * step headers stay on screen while each step's tool list sticks internally.
 */
export function scrollStepToHostTop(
  host: HTMLElement,
  stepEl: HTMLElement,
  topInsetPx = 8,
): void {
  const top = offsetInScrollHost(host, stepEl)
  host.scrollTop = Math.max(0, top - topInsetPx)
}
