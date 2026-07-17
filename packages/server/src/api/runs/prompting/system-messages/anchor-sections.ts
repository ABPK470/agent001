/**
 * system_anchor sections — core identity and session continuity.
 * Base prompt, environment, prior turns/results, known warehouse objects,
 * and clarification discipline. Kept when the budget compactor trims later sections.
 */

import {
  buildPromptVars,
  CLARIFICATION_DISCIPLINE_SECTION,
  DEFAULT_SYSTEM_PROMPT,
  getCatalog,
  MessageRole,
  renderPromptVars,
  type Message
} from "@mia/agent"
import {
  renderKnownObjectsBlock,
  type CandidateVerdictRow,
  type KnownObjectRow
} from "../data-blocks/known-objects.js"
import { renderPriorResultsBlock } from "../data-blocks/prior-results-block.js"
import type { PriorTurn } from "../data-blocks/prior-turns.js"
import { buildEnvironmentContext } from "../prompt/builder.js"
import type { BuildContext } from "./types.js"
import { renderPriorTurnsBlock } from "./prior-turns.js"

export function buildAnchorSections(ctx: BuildContext): Message[] {
  const { opts, isAdmin, priorTurns, priorResults, knownObjects, knownVerdicts } = ctx
  const messages: Message[] = []

  const basePrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT
  const promptVars = buildPromptVars({
    accessor: () => (opts.host ? getCatalog(opts.host, "default") : null)
  })
  const envBlock = buildEnvironmentContext({ isAdmin })
  messages.push({
    role: MessageRole.System,
    content: `${renderPromptVars(basePrompt, promptVars)}\n${envBlock}`,
    section: "system_anchor"
  })

  if (priorTurns.length > 0) {
    messages.push({
      role: MessageRole.System,
      content: renderPriorTurnsBlock(priorTurns),
      section: "system_anchor"
    })
  }

  if (priorResults.length > 0) {
    const block = renderPriorResultsBlock(priorResults)
    if (block.length > 0) {
      messages.push({ role: MessageRole.System, content: block, section: "system_anchor" })
    }
  }

  if (knownObjects.length > 0 || knownVerdicts.length > 0) {
    const block = renderKnownObjectsBlock(knownObjects, knownVerdicts)
    if (block.length > 0) {
      messages.push({ role: MessageRole.System, content: block, section: "system_anchor" })
    }
  }

  messages.push({
    role: MessageRole.System,
    content: CLARIFICATION_DISCIPLINE_SECTION,
    section: "system_anchor"
  })

  return messages
}

// Re-export for tests that import render helpers
export type { PriorTurn, KnownObjectRow, CandidateVerdictRow }
