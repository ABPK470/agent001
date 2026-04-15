/**
 * Prompt budget types, constants, and section configuration.
 *
 * Extracted from prompt-budget.ts to keep modules under 500 LOC.
 *
 * @module
 */

import type { Message, PromptBudgetSection } from "./types.js"

// ============================================================================
// Types
// ============================================================================

export interface PromptBudgetConfig {
  readonly contextWindowTokens?: number
  readonly maxOutputTokens?: number
  readonly charPerToken?: number
  readonly safetyMarginTokens?: number
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

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 32_768
export const DEFAULT_MAX_OUTPUT_TOKENS = 2_048
export const DEFAULT_CHAR_PER_TOKEN = 4
export const DEFAULT_SAFETY_MARGIN_TOKENS = 1_024
export const DEFAULT_HARD_MAX_PROMPT_CHARS = 100_000
export const MIN_PROMPT_CHAR_BUDGET = 8_000
export const MAX_PROMPT_CHAR_BUDGET = 1_500_000

// ============================================================================
// Section specs & behavior
// ============================================================================

export type BaseSectionKey = "system" | "memory" | "history" | "user" | "other"
export const BASE_SECTION_KEYS: readonly BaseSectionKey[] = ["system", "memory", "history", "user", "other"]

export interface SectionSpec {
  readonly key: BaseSectionKey
  readonly weight: number
  readonly minChars: number
  readonly maxChars: number
}

export const BASE_SECTION_SPECS: readonly SectionSpec[] = [
  { key: "system", weight: 0.25, minChars: 2_048, maxChars: 40_000 },
  { key: "memory", weight: 0.20, minChars: 1_536, maxChars: 30_000 },
  { key: "history", weight: 0.35, minChars: 2_048, maxChars: 50_000 },
  { key: "user", weight: 0.12, minChars: 1_536, maxChars: 16_000 },
  { key: "other", weight: 0.08, minChars: 512, maxChars: 12_000 },
]

export const SECTION_ORDER: readonly PromptBudgetSection[] = [
  "system_anchor",
  "system_runtime",
  "memory_working",
  "memory_episodic",
  "memory_semantic",
  "history",
  "user",
]

export interface SectionBehavior {
  readonly dropAllowed: boolean
  readonly newestFirst: boolean
}

export const SECTION_BEHAVIOR: Record<PromptBudgetSection, SectionBehavior> = {
  system_anchor: { dropAllowed: false, newestFirst: false },
  system_runtime: { dropAllowed: true, newestFirst: true },
  memory_working: { dropAllowed: true, newestFirst: true },
  memory_episodic: { dropAllowed: true, newestFirst: true },
  memory_semantic: { dropAllowed: true, newestFirst: true },
  history: { dropAllowed: true, newestFirst: true },
  user: { dropAllowed: false, newestFirst: false },
}
