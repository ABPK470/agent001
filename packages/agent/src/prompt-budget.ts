/**
 * Prompt budget allocation system — ported from agenc-core's prompt-budget.ts (839 lines).
 *
 * Section-aware context window management that:
 *   1. Derives per-section budgets from the model's context window
 *   2. Rebalances slack from under-used sections to over-used ones
 *   3. Drops/truncates messages per section using priority rules
 *   4. Preserves anchored sections (system anchor, user, tools) from drops
 *   5. Reports diagnostics for observability
 *
 * @module
 */

import type { Message, PromptBudgetSection } from "./types.js"

// ============================================================================
// Types
// ============================================================================

export interface PromptBudgetConfig {
  /** Provider/model context window in tokens. */
  readonly contextWindowTokens?: number
  /** Requested max output tokens. */
  readonly maxOutputTokens?: number
  /** Approximate chars-per-token (default: 4). */
  readonly charPerToken?: number
  /** Safety margin reserved for protocol overhead. */
  readonly safetyMarginTokens?: number
  /** Hard upper bound on prompt chars after allocation. */
  readonly hardMaxPromptChars?: number
}

export interface PromptBudgetModelProfile {
  readonly contextWindowTokens: number
  readonly maxOutputTokens: number
  readonly safetyMarginTokens: number
  readonly promptTokenBudget: number
  readonly charPerToken: number
}

export interface PromptBudgetCaps {
  readonly totalChars: number
  readonly systemChars: number
  readonly systemAnchorChars: number
  readonly systemRuntimeChars: number
  readonly memoryChars: number
  readonly memoryWorkingChars: number
  readonly memoryEpisodicChars: number
  readonly memorySemanticChars: number
  readonly historyChars: number
  readonly userChars: number
  readonly otherChars: number
}

export interface PromptBudgetSectionStats {
  readonly capChars: number
  readonly beforeMessages: number
  readonly afterMessages: number
  readonly beforeChars: number
  readonly afterChars: number
  readonly droppedMessages: number
  readonly truncatedMessages: number
}

export interface PromptBudgetDiagnostics {
  readonly model: PromptBudgetModelProfile
  readonly caps: PromptBudgetCaps
  readonly totalBeforeChars: number
  readonly totalAfterChars: number
  readonly constrained: boolean
  readonly droppedSections: readonly PromptBudgetSection[]
  readonly sections: Record<PromptBudgetSection, PromptBudgetSectionStats>
}

export interface PromptBudgetPlan {
  readonly model: PromptBudgetModelProfile
  readonly caps: PromptBudgetCaps
}

export interface PromptBudgetAllocationResult {
  readonly messages: Message[]
  readonly diagnostics: PromptBudgetDiagnostics
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_CONTEXT_WINDOW_TOKENS = 32_768
const DEFAULT_MAX_OUTPUT_TOKENS = 2_048
const DEFAULT_CHAR_PER_TOKEN = 4
const DEFAULT_SAFETY_MARGIN_TOKENS = 1_024
const DEFAULT_HARD_MAX_PROMPT_CHARS = 100_000
const MIN_PROMPT_CHAR_BUDGET = 8_000
const MAX_PROMPT_CHAR_BUDGET = 1_500_000

// ============================================================================
// Section specs & behavior
// ============================================================================

type BaseSectionKey = "system" | "memory" | "history" | "user" | "other"
const BASE_SECTION_KEYS: readonly BaseSectionKey[] = ["system", "memory", "history", "user", "other"]

interface SectionSpec {
  readonly key: BaseSectionKey
  readonly weight: number
  readonly minChars: number
  readonly maxChars: number
}

const BASE_SECTION_SPECS: readonly SectionSpec[] = [
  { key: "system", weight: 0.25, minChars: 2_048, maxChars: 40_000 },
  { key: "memory", weight: 0.20, minChars: 1_536, maxChars: 30_000 },
  { key: "history", weight: 0.35, minChars: 2_048, maxChars: 50_000 },
  { key: "user", weight: 0.12, minChars: 1_536, maxChars: 16_000 },
  { key: "other", weight: 0.08, minChars: 512, maxChars: 12_000 },
]

const SECTION_ORDER: readonly PromptBudgetSection[] = [
  "system_anchor",
  "system_runtime",
  "memory_working",
  "memory_episodic",
  "memory_semantic",
  "history",
  "user",
]

interface SectionBehavior {
  readonly dropAllowed: boolean
  readonly newestFirst: boolean
}

const SECTION_BEHAVIOR: Record<PromptBudgetSection, SectionBehavior> = {
  system_anchor: { dropAllowed: false, newestFirst: false },
  system_runtime: { dropAllowed: true, newestFirst: true },
  memory_working: { dropAllowed: true, newestFirst: true },
  memory_episodic: { dropAllowed: true, newestFirst: true },
  memory_semantic: { dropAllowed: true, newestFirst: true },
  history: { dropAllowed: true, newestFirst: true },
  user: { dropAllowed: false, newestFirst: false },
}

// ============================================================================
// Helpers
// ============================================================================

interface WorkingEntry {
  readonly index: number
  readonly beforeChars: number
  readonly section: PromptBudgetSection
  message: Message
  dropped: boolean
  truncated: boolean
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  if (maxChars <= 3) return value.slice(0, Math.max(0, maxChars))
  return value.slice(0, maxChars - 3) + "..."
}

function estimateMessageChars(message: Message): number {
  return (typeof message.content === "string" ? message.content.length : 0) + 64
}

function normalizeCaps(
  rawCaps: Record<BaseSectionKey, number>,
  specs: readonly SectionSpec[],
  totalChars: number,
): Record<BaseSectionKey, number> {
  const normalized = { ...rawCaps }
  const rawTotal = BASE_SECTION_KEYS.reduce((sum, key) => sum + normalized[key], 0)

  if (rawTotal > totalChars) {
    for (const spec of specs) {
      const scaledValue = Math.floor((normalized[spec.key] * totalChars) / rawTotal)
      normalized[spec.key] = clamp(scaledValue, spec.minChars, spec.maxChars)
    }
  }

  let adjustedTotal = BASE_SECTION_KEYS.reduce((sum, key) => sum + normalized[key], 0)
  if (adjustedTotal > totalChars) {
    for (const spec of [...specs].sort((a, b) => b.weight - a.weight)) {
      if (adjustedTotal <= totalChars) break
      const reducible = normalized[spec.key] - spec.minChars
      if (reducible <= 0) continue
      const delta = Math.min(reducible, adjustedTotal - totalChars)
      normalized[spec.key] -= delta
      adjustedTotal -= delta
    }
  } else if (adjustedTotal < totalChars) {
    for (const spec of [...specs].sort((a, b) => b.weight - a.weight)) {
      if (adjustedTotal >= totalChars) break
      const expandable = spec.maxChars - normalized[spec.key]
      if (expandable <= 0) continue
      const delta = Math.min(expandable, totalChars - adjustedTotal)
      normalized[spec.key] += delta
      adjustedTotal += delta
    }
  }

  return normalized
}

// ============================================================================
// Plan derivation
// ============================================================================

export function derivePromptBudgetPlan(config?: PromptBudgetConfig): PromptBudgetPlan {
  const contextWindowTokens = clamp(
    Math.floor(config?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS),
    2_048,
    2_000_000,
  )
  const maxOutputTokens = clamp(
    Math.floor(config?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS),
    128,
    Math.max(256, contextWindowTokens - 1_024),
  )
  const safetyMarginTokens = clamp(
    Math.floor(
      config?.safetyMarginTokens ??
        Math.max(DEFAULT_SAFETY_MARGIN_TOKENS, Math.floor(contextWindowTokens * 0.05)),
    ),
    256,
    Math.max(512, Math.floor(contextWindowTokens * 0.5)),
  )
  const promptTokenBudget = Math.max(1_024, contextWindowTokens - maxOutputTokens - safetyMarginTokens)
  const charPerToken = clamp(Math.floor(config?.charPerToken ?? DEFAULT_CHAR_PER_TOKEN), 2, 8)
  const hardMaxPromptChars = clamp(
    Math.floor(config?.hardMaxPromptChars ?? DEFAULT_HARD_MAX_PROMPT_CHARS),
    MIN_PROMPT_CHAR_BUDGET,
    MAX_PROMPT_CHAR_BUDGET,
  )
  const totalChars = clamp(
    Math.floor(promptTokenBudget * charPerToken),
    MIN_PROMPT_CHAR_BUDGET,
    hardMaxPromptChars,
  )

  const rawCaps: Record<BaseSectionKey, number> = { system: 0, memory: 0, history: 0, user: 0, other: 0 }
  for (const spec of BASE_SECTION_SPECS) {
    const proportional = Math.floor(totalChars * spec.weight)
    rawCaps[spec.key] = clamp(proportional, spec.minChars, spec.maxChars)
  }
  const normalizedBase = normalizeCaps(rawCaps, BASE_SECTION_SPECS, totalChars)

  const systemAnchorChars = clamp(Math.floor(normalizedBase.system * 0.75), 512, normalizedBase.system)
  const systemRuntimeChars = Math.max(0, normalizedBase.system - systemAnchorChars)

  // Split memory budget: working 45%, episodic 30%, semantic 25%
  const memoryTotal = normalizedBase.memory
  const memoryWorkingChars = Math.floor(memoryTotal * 0.45)
  const memoryEpisodicChars = Math.floor(memoryTotal * 0.30)
  const memorySemanticChars = Math.max(0, memoryTotal - memoryWorkingChars - memoryEpisodicChars)

  const usedByTop = normalizedBase.system + normalizedBase.memory + normalizedBase.history + normalizedBase.user
  const otherChars = Math.max(0, totalChars - usedByTop)

  return {
    model: {
      contextWindowTokens,
      maxOutputTokens,
      safetyMarginTokens,
      promptTokenBudget,
      charPerToken,
    },
    caps: {
      totalChars,
      systemChars: normalizedBase.system,
      systemAnchorChars,
      systemRuntimeChars,
      memoryChars: normalizedBase.memory,
      memoryWorkingChars,
      memoryEpisodicChars,
      memorySemanticChars,
      historyChars: normalizedBase.history,
      userChars: normalizedBase.user,
      otherChars,
    },
  }
}

// ============================================================================
// Section caps
// ============================================================================

function getSectionCap(caps: PromptBudgetCaps, section: PromptBudgetSection): number {
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

function createSectionCapMap(caps: PromptBudgetCaps): Record<PromptBudgetSection, number> {
  const result: Record<PromptBudgetSection, number> = {} as Record<PromptBudgetSection, number>
  for (const section of SECTION_ORDER) {
    result[section] = getSectionCap(caps, section)
  }
  return result
}

// ============================================================================
// Section rebalancing
// ============================================================================

function rebalanceSectionCaps(
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

// ============================================================================
// Section resolution
// ============================================================================

function resolveSections(messages: readonly Message[]): PromptBudgetSection[] {
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

// ============================================================================
// Message truncation
// ============================================================================

function truncateMessage(entry: WorkingEntry, maxChars: number): void {
  const content = entry.message.content
  if (typeof content !== "string") return

  const truncated = truncateText(content, Math.max(0, maxChars))
  if (truncated.length < content.length) {
    entry.truncated = true
    entry.message = { ...entry.message, content: truncated }
  }
}

// ============================================================================
// Main allocation
// ============================================================================

export function applyPromptBudget(
  messages: readonly Message[],
  config?: PromptBudgetConfig,
): PromptBudgetAllocationResult {
  const plan = derivePromptBudgetPlan(config)
  const sections = resolveSections(messages)

  const working: WorkingEntry[] = messages.map((msg, index) => ({
    index,
    beforeChars: estimateMessageChars(msg),
    section: sections[index],
    message: msg,
    dropped: false,
    truncated: false,
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
        const perMessageBudget = remainingEntries > 0
          ? Math.max(16, Math.floor(remainingBudget / remainingEntries))
          : 16
        truncateMessage(entry, perMessageBudget)
        used += estimateMessageChars(entry.message)
      }
    }
  }

  const finalEntries = working
    .filter(e => !e.dropped)
    .sort((a, b) => a.index - b.index)
  const finalMessages = finalEntries.map(e => e.message)

  const totalAfterChars = finalEntries.reduce((sum, e) => sum + estimateMessageChars(e.message), 0)

  // Build diagnostics
  const sectionStats = {} as Record<PromptBudgetSection, PromptBudgetSectionStats>
  for (const section of SECTION_ORDER) {
    sectionStats[section] = {
      capChars: sectionCaps[section],
      beforeMessages: 0, afterMessages: 0,
      beforeChars: 0, afterChars: 0,
      droppedMessages: 0, truncatedMessages: 0,
    }
  }
  for (const entry of working) {
    const s = sectionStats[entry.section]
    sectionStats[entry.section] = {
      ...s,
      beforeMessages: s.beforeMessages + 1,
      beforeChars: s.beforeChars + entry.beforeChars,
      droppedMessages: s.droppedMessages + (entry.dropped ? 1 : 0),
      truncatedMessages: s.truncatedMessages + (entry.truncated ? 1 : 0),
    }
  }
  for (const entry of finalEntries) {
    const s = sectionStats[entry.section]
    sectionStats[entry.section] = {
      ...s,
      afterMessages: s.afterMessages + 1,
      afterChars: s.afterChars + estimateMessageChars(entry.message),
    }
  }

  const droppedSections = SECTION_ORDER.filter(s => {
    const stats = sectionStats[s]
    return stats.beforeChars > 0 && stats.afterChars === 0
  })
  const constrained =
    totalAfterChars < totalBeforeChars ||
    droppedSections.length > 0 ||
    SECTION_ORDER.some(s => sectionStats[s].truncatedMessages > 0)

  return {
    messages: finalMessages,
    diagnostics: {
      model: plan.model,
      caps: plan.caps,
      totalBeforeChars,
      totalAfterChars,
      constrained,
      droppedSections,
      sections: sectionStats,
    },
  }
}
