/**
 * Prompt budget plan derivation — turns a `PromptBudgetConfig` into a
 * concrete `PromptBudgetPlan` (model envelope + per-section char caps).
 *
 * Pure function — no message inspection, no side effects.
 *
 * @module
 */

import { BASE_SECTION_KEYS } from "../../domain/enums/context.js"
import {
    BASE_SECTION_SPECS,
    DEFAULT_CHAR_PER_TOKEN,
    DEFAULT_CONTEXT_WINDOW_TOKENS,
    DEFAULT_HARD_MAX_PROMPT_CHARS,
    DEFAULT_MAX_OUTPUT_TOKENS,
    DEFAULT_SAFETY_MARGIN_TOKENS,
    MAX_PROMPT_CHAR_BUDGET,
    MIN_PROMPT_CHAR_BUDGET,
    type BaseSectionKey,
    type PromptBudgetConfig,
    type PromptBudgetPlan,
    type SectionSpec,
} from "../prompt-budget-types.js"

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function normalizeCaps(
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
