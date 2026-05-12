/**
 * Internal helpers for prompt-budget allocation.
 *
 * Extracted from prompt-budget.ts to keep that file under the 450-LOC threshold.
 * @module
 */

import { SECTION_ORDER, type PromptBudgetCaps } from "./prompt-budget-types.js"
import type { Message, PromptBudgetSection } from "../types.js"

// ── Working entry ─────────────────────────────────────────────────

export interface WorkingEntry {
  readonly index: number
  readonly beforeChars: number
  readonly section: PromptBudgetSection
  message: Message
  dropped: boolean
  truncated: boolean
}

// ── Text helpers ──────────────────────────────────────────────────

export function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  if (maxChars <= 3) return value.slice(0, Math.max(0, maxChars))
  return value.slice(0, maxChars - 3) + "..."
}

export function estimateMessageChars(message: Message): number {
  return (typeof message.content === "string" ? message.content.length : 0) + 64
}

// ── Section caps ──────────────────────────────────────────────────

export function getSectionCap(caps: PromptBudgetCaps, section: PromptBudgetSection): number {
  switch (section) {
    case "system_anchor": return caps.systemAnchorChars
    case "system_runtime": return caps.systemRuntimeChars
    case "memory_working": return caps.memoryWorkingChars
    case "memory_episodic": return caps.memoryEpisodicChars
    case "memory_semantic": return caps.memorySemanticChars
    case "history": return caps.historyChars
    case "user": return caps.userChars
    default: return caps.otherChars
  }
}

export function createSectionCapMap(caps: PromptBudgetCaps): Record<PromptBudgetSection, number> {
  const result: Record<PromptBudgetSection, number> = {} as Record<PromptBudgetSection, number>
  for (const section of SECTION_ORDER) {
    result[section] = getSectionCap(caps, section)
  }
  return result
}

// ── Section rebalancing ───────────────────────────────────────────

export function rebalanceSectionCaps(
  baseCaps: Record<PromptBudgetSection, number>,
  beforeChars: Record<PromptBudgetSection, number>,
): Record<PromptBudgetSection, number> {
  const effective = { ...baseCaps }
  let slack = 0
  for (const section of SECTION_ORDER) {
    const unused = effective[section] - beforeChars[section]
    if (unused > 0) slack += unused
  }
  if (slack <= 0) return effective

  // Redistribute slack to sections that need it, in priority order
  const deficitOrder: PromptBudgetSection[] = [
    "history",
    "system_runtime",
    "memory_working",
    "memory_episodic",
    "memory_semantic",
    "user",
    "system_anchor",
  ]
  for (const section of deficitOrder) {
    if (slack <= 0) break
    const deficit = beforeChars[section] - effective[section]
    if (deficit <= 0) continue
    const delta = Math.min(deficit, slack)
    effective[section] += delta
    slack -= delta
  }
  return effective
}

// ── Section resolution ────────────────────────────────────────────

export function resolveSections(messages: readonly Message[]): PromptBudgetSection[] {
  const lastUserIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return i
    }
    return -1
  })()

  let anchorAssigned = false
  return messages.map((msg, index) => {
    // If the message already has a section tag, use it
    if (msg.section) {
      if (msg.section === "system_anchor") {
        if (!anchorAssigned) {
          anchorAssigned = true
          return "system_anchor"
        }
        return "system_runtime"
      }
      return msg.section
    }

    // Auto-resolve section from role
    if (msg.role === "system") {
      if (!anchorAssigned) {
        anchorAssigned = true
        return "system_anchor"
      }
      return "system_runtime"
    }
    if (msg.role === "tool") return "history"
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) return "history"
    if (msg.role === "user") {
      return index === lastUserIndex ? "user" : "history"
    }
    if (msg.role === "assistant") return "history"
    return "history"
  })
}

// ── Message truncation ────────────────────────────────────────────

export function truncateMessage(entry: WorkingEntry, maxChars: number): void {
  const content = entry.message.content
  if (typeof content !== "string") return

  const truncated = truncateText(content, Math.max(0, maxChars))
  if (truncated.length < content.length) {
    entry.truncated = true
    entry.message = { ...entry.message, content: truncated }
  }
}
