/**
 * Injects the three memory tiers into the system prompt when retrieval found content.
 *
 * Working and semantic are passed through as-is. Episodic is special: it often
 * contains a summary of an older run with the same (or similar) goal — lines like
 * "Status: completed" and "Answer: …". When that summary looks trustworthy
 * (completed, not failed, not a clarification punt), we prepend extra instructions
 * telling the model it may reuse tables/columns from that answer instead of calling
 * search_catalog again. Working/semantic never get that banner because they do not
 * carry that prior-run shape.
 */

import { MessageRole, type Message } from "@mia/agent"
import { buildMemoryGuidance } from "../prompt/builder.js"
import type { BuildContext } from "./types.js"

const PUNT_PATTERNS = [
  "please provide more details",
  "please clarify",
  "if you meant",
  "could you clarify",
  "i wasn't able to",
  "unable to find",
  "no tables explicitly mention",
  "if it refers to",
  "let me know which",
  "please let me know"
]

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
    const episodicAnswerSection = perTier.episodic.match(/Answer:([\s\S]+?)(?=\nGoal:|\s*$)/i)?.[1] ?? ""
    const hasPuntAnswer = PUNT_PATTERNS.some((p) => episodicAnswerSection.toLowerCase().includes(p))
    const episodicHasCompletedEntry =
      perTier.episodic.includes("Status: completed") &&
      !perTier.episodic.includes("Answer: Task FAILED") &&
      !hasPuntAnswer

    const episodicContent = episodicHasCompletedEntry
      ? [
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
          "interpretation of unfamiliar domain concepts.",
          "",
          perTier.episodic
        ].join("\n")
      : perTier.episodic

    messages.push({
      role: MessageRole.System,
      content: `<episodic_memory>\n${episodicContent}\n</episodic_memory>`,
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
