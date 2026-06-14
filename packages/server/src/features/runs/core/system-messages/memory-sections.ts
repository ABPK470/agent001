/**
 * Injects the three memory tiers into the system prompt when retrieval found content.
 *
 * Episodic shortcut banner uses `perTier.episodicShortcutEligible` — set at ingest
 * from run status, tools, and trace (see episodic-quality.ts), not prose heuristics.
 * Choreography hints come from ordered tool sequences on the same episodic row.
 */

import { MessageRole, type Message } from "@mia/agent"
import { buildMemoryGuidance } from "../prompt/builder.js"
import type { BuildContext } from "./types.js"

const EPISODIC_SHORTCUT_BANNER = [
  "⚠️ MEMORY HIT — prior completed run found for this goal.",
  "SHORTCUT: For tables/columns/queries already confirmed in the Answer below, use them",
  "directly — skip redundant search_catalog or explore_mssql_schema calls for those.",
  "The 'NEVER skip search_catalog' rule is satisfied — memory IS the prior evidence.",
  "",
  "IMPORTANT EXCEPTION — Tool Orchestration override:",
  "If the goal involves an unfamiliar technical term (SQL Server internals like 'tombstone',",
  "'ghost records', 'WAL', 'fill factor', 'spinlock', etc.), ALWAYS use fetch_url to search",
  "the internet FIRST, regardless of what memory shows. Prior runs may have guessed wrong",
  "about what those terms mean. Memory shortcuts apply to table/column names, not to the",
  "interpretation of unfamiliar domain concepts."
].join("\n")

const EPISODIC_CHOREOGRAPHY_PREFIX =
  "PRIOR CHOREOGRAPHY (hint only — adapt tool args to this goal):"

function buildEpisodicBlock(perTier: BuildContext["opts"]["perTier"]): string {
  const parts: string[] = []
  if (perTier.episodicShortcutEligible === true) {
    parts.push(EPISODIC_SHORTCUT_BANNER)
    if (perTier.episodicChoreography) {
      parts.push(`${EPISODIC_CHOREOGRAPHY_PREFIX}\n${perTier.episodicChoreography}`)
    }
  }
  parts.push(perTier.episodic)
  return parts.join("\n\n")
}

export function buildMemorySections(ctx: BuildContext): Message[] {
  const { opts, decision } = ctx
  const { perTier } = opts
  const messages: Message[] = []

  if (perTier.working) {
    messages.push({
      role: MessageRole.System,
      content: `<working_memory>\n${perTier.working}\n</working_memory>`,
      section: "memory_working"
    })
  }

  if (perTier.episodic) {
    messages.push({
      role: MessageRole.System,
      content: `<episodic_memory>\n${buildEpisodicBlock(perTier)}\n</episodic_memory>`,
      section: "memory_episodic"
    })
  }

  if (perTier.semantic) {
    messages.push({
      role: MessageRole.System,
      content: `<semantic_memory>\n${perTier.semantic}\n</semantic_memory>`,
      section: "memory_semantic"
    })
  }

  if (decision.includeMemoryGuidance) {
    messages.push({
      role: MessageRole.System,
      content: buildMemoryGuidance(),
      section: "memory_semantic"
    })
  }

  return messages
}

export function markCacheBreakpoint(messages: Message[]): void {
  if (messages.length > 0) {
    messages[messages.length - 1].cacheHint = "ephemeral"
  }
}
