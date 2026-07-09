/**
 * System prompt assembly for each agent run.
 *
 * Builds an ordered list of system messages (not one giant string) so the
 * token budget can drop droppable sections on long runs. Called once at run
 * start from run-executor before the first LLM call.
 */

import type { Message } from "@mia/agent"
import { buildAnchorSections } from "./anchor-sections.js"
import { buildCoordinationSections } from "./coordination-sections.js"
import { createBuildContext, logSectionDecision } from "./context.js"
import { buildKnowledgeSections } from "./knowledge-sections.js"
import { buildLawSections } from "./law-sections.js"
import { buildMemorySections, markCacheBreakpoint } from "./memory-sections.js"
import { buildRuntimeSections } from "./runtime-sections.js"
import type { BuildSystemMessagesOptions } from "./types.js"

export type { BuildSystemMessagesOptions } from "./types.js"

export async function buildSystemMessages(opts: BuildSystemMessagesOptions): Promise<Message[]> {
  const ctx = createBuildContext(opts)
  logSectionDecision(ctx)

  const messages: Message[] = [
    ...(await buildLawSections(ctx)),
    ...buildAnchorSections(ctx),
    ...buildKnowledgeSections(ctx),
    ...buildCoordinationSections(ctx),
    ...(await buildRuntimeSections(ctx)),
    ...buildMemorySections(ctx)
  ]

  markCacheBreakpoint(messages)
  return messages
}
