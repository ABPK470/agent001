/**
 * Prompt budget allocation system — section-aware context window management.
 *
 * Types and section configuration are in prompt-budget-types.ts.
 * Plan derivation (config → caps) lives in prompt-budget/derive-plan.ts.
 *
 * @module
 */

import type { Message, PromptBudgetSection } from "../../domain/agent-types.js"
import {
  createSectionCapMap,
  estimateMessageChars,
  rebalanceSectionCaps,
  resolveSections,
  truncateMessage,
  type WorkingEntry
} from "../internal/prompt-budget-helpers.js"
import {
  SECTION_BEHAVIOR,
  SECTION_ORDER,
  type PromptBudgetAllocationResult,
  type PromptBudgetConfig,
  type PromptBudgetSectionStats
} from "../prompt-budget-types.js"
import { derivePromptBudgetPlan } from "./derive-plan.js"
import { tokensBySection } from "../tokens.js"

// Re-export plan derivation
export { derivePromptBudgetPlan } from "./derive-plan.js"

// Re-export all types for backwards compatibility
export type {
  PromptBudgetAllocationResult,
  PromptBudgetCaps,
  PromptBudgetConfig,
  PromptBudgetDiagnostics,
  PromptBudgetModelProfile,
  PromptBudgetPlan,
  PromptBudgetSectionStats
} from "../prompt-budget-types.js"

// ============================================================================
// Main allocation
// ============================================================================

export function applyPromptBudget(
  messages: readonly Message[],
  config?: PromptBudgetConfig
): PromptBudgetAllocationResult {
  const plan = derivePromptBudgetPlan(config)
  const sections = resolveSections(messages)

  const working: WorkingEntry[] = messages.map((msg, index) => ({
    index,
    beforeChars: estimateMessageChars(msg),
    section: sections[index],
    message: msg,
    dropped: false,
    truncated: false
  }))

  // Group by section
  const bySection = new Map<PromptBudgetSection, WorkingEntry[]>()
  for (const section of SECTION_ORDER) {
    bySection.set(section, [])
  }
  for (const entry of working) {
    bySection.get(entry.section)?.push(entry)
  }

  const baseSectionCaps = createSectionCapMap(plan.caps)
  const sectionBeforeChars = {} as Record<PromptBudgetSection, number>
  for (const section of SECTION_ORDER) {
    const entries = bySection.get(section) ?? []
    sectionBeforeChars[section] = entries.reduce((sum, e) => sum + e.beforeChars, 0)
  }

  const totalBeforeChars = working.reduce((sum, e) => sum + e.beforeChars, 0)
  const constrainedByTotal = totalBeforeChars > plan.caps.totalChars

  const sectionCaps = constrainedByTotal
    ? rebalanceSectionCaps(baseSectionCaps, sectionBeforeChars)
    : baseSectionCaps

  if (constrainedByTotal) {
    for (const section of SECTION_ORDER) {
      const entries = bySection.get(section) ?? []
      if (entries.length === 0) continue

      const behavior = SECTION_BEHAVIOR[section]
      const cap = sectionCaps[section]

      if (behavior.dropAllowed) {
        // Sort: keep newest first (or oldest first for history)
        const ordered = behavior.newestFirst
          ? [...entries].sort((a, b) => b.index - a.index)
          : [...entries].sort((a, b) => a.index - b.index)
        let used = 0
        let kept = 0

        for (const entry of ordered) {
          const remaining = cap - used
          if (remaining <= 0) {
            entry.dropped = true
            continue
          }
          if (entry.beforeChars <= remaining) {
            used += entry.beforeChars
            kept++
            continue
          }
          if (kept === 0) {
            // Keep at least one entry per section, truncated
            truncateMessage(entry, remaining)
            used += estimateMessageChars(entry.message)
            kept++
            continue
          }
          entry.dropped = true
        }
        continue
      }

      // Non-droppable: truncate evenly
      const ordered = behavior.newestFirst
        ? [...entries].sort((a, b) => b.index - a.index)
        : [...entries].sort((a, b) => a.index - b.index)
      let used = 0
      for (let i = 0; i < ordered.length; i++) {
        const entry = ordered[i]
        const remainingEntries = ordered.length - i
        const remainingBudget = Math.max(0, cap - used)
        const perMessageBudget =
          remainingEntries > 0 ? Math.max(16, Math.floor(remainingBudget / remainingEntries)) : 16
        truncateMessage(entry, perMessageBudget)
        used += estimateMessageChars(entry.message)
      }
    }
  }

  const finalEntries = working.filter((e) => !e.dropped).sort((a, b) => a.index - b.index)
  const finalMessages = finalEntries.map((e) => e.message)

  const totalAfterChars = finalEntries.reduce((sum, e) => sum + estimateMessageChars(e.message), 0)

  // Build diagnostics
  const sectionStats = {} as Record<PromptBudgetSection, PromptBudgetSectionStats>
  for (const section of SECTION_ORDER) {
    sectionStats[section] = {
      capChars: sectionCaps[section],
      beforeMessages: 0,
      afterMessages: 0,
      beforeChars: 0,
      afterChars: 0,
      droppedMessages: 0,
      truncatedMessages: 0
    }
  }
  for (const entry of working) {
    const s = sectionStats[entry.section]
    sectionStats[entry.section] = {
      ...s,
      beforeMessages: s.beforeMessages + 1,
      beforeChars: s.beforeChars + entry.beforeChars,
      droppedMessages: s.droppedMessages + (entry.dropped ? 1 : 0),
      truncatedMessages: s.truncatedMessages + (entry.truncated ? 1 : 0)
    }
  }
  for (const entry of finalEntries) {
    const s = sectionStats[entry.section]
    sectionStats[entry.section] = {
      ...s,
      afterMessages: s.afterMessages + 1,
      afterChars: s.afterChars + estimateMessageChars(entry.message)
    }
  }

  const droppedSections = SECTION_ORDER.filter((s) => {
    const stats = sectionStats[s]
    return stats.beforeChars > 0 && stats.afterChars === 0
  })
  const constrained =
    totalAfterChars < totalBeforeChars ||
    droppedSections.length > 0 ||
    SECTION_ORDER.some((s) => sectionStats[s].truncatedMessages > 0)

  if (config?.onSectionSizes) {
    try {
      config.onSectionSizes(tokensBySection(finalMessages, config?.model))
    } catch {
      // Telemetry must never break a real LLM call.
    }
  }

  return {
    messages: finalMessages,
    diagnostics: {
      model: plan.model,
      caps: plan.caps,
      totalBeforeChars,
      totalAfterChars,
      constrained,
      droppedSections,
      sections: sectionStats
    }
  }
}
