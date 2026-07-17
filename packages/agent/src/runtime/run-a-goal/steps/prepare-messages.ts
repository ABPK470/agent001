/**
 * Prepare messages.
 *
 * Input: user goal + agent config (system prompt / system messages).
 * Output: the starting message list for this run.
 * Next: tryPlannerPath (unless resuming) or the tool loop.
 */

import type { Message } from "../../../domain/types/agent-types.js"
import { buildInitialMessages } from "../agent-helpers.js"

export function prepareMessages(
  goal: string,
  config: {
    systemPrompt: string
    systemMessages: Message[] | undefined
  }
): Message[] {
  return buildInitialMessages(goal, {
    systemPrompt: config.systemPrompt,
    systemMessages: config.systemMessages
  })
}
