/**
 * Per-model token pricing for trace cost enrichment (USD per 1M tokens).
 * Static v1 table — policy/config can replace this later without widget changes.
 */

export type ModelPricing = {
  inputPer1M: number
  outputPer1M: number
}

/** Normalized model id → pricing. Unknown models fall back to DEFAULT_PRICING. */
export const TRACE_MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-4.1": { inputPer1M: 2, outputPer1M: 8 },
  "gpt-4.1-mini": { inputPer1M: 0.4, outputPer1M: 1.6 },
  "gpt-4.1-nano": { inputPer1M: 0.1, outputPer1M: 0.4 },
  "o3": { inputPer1M: 2, outputPer1M: 8 },
  "o3-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
  "o4-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
  "claude-sonnet-4": { inputPer1M: 3, outputPer1M: 15 },
  "claude-opus-4": { inputPer1M: 15, outputPer1M: 75 },
  "claude-haiku-4": { inputPer1M: 0.8, outputPer1M: 4 },
}

const DEFAULT_PRICING: ModelPricing = { inputPer1M: 2.5, outputPer1M: 10 }

export function normalizeModelId(model: string | null | undefined): string | null {
  if (!model) return null
  const trimmed = model.trim().toLowerCase()
  if (!trimmed) return null
  return trimmed
}

export function pricingForModel(model: string | null | undefined): ModelPricing {
  const id = normalizeModelId(model)
  if (!id) return DEFAULT_PRICING
  return TRACE_MODEL_PRICING[id] ?? DEFAULT_PRICING
}

export function computeTokenCostUsd(
  model: string | null | undefined,
  promptTokens: number,
  completionTokens: number,
): number {
  const rates = pricingForModel(model)
  const input = (promptTokens / 1_000_000) * rates.inputPer1M
  const output = (completionTokens / 1_000_000) * rates.outputPer1M
  return input + output
}

/** LangSmith-style precision for small spans — at least 4 significant digits. */
export function formatCostUsd(usd: number): string {
  if (usd === 0) return "$0"
  if (usd >= 0.01) return `$${usd.toFixed(4)}`
  if (usd >= 0.0001) return `$${usd.toFixed(4)}`
  if (usd >= 0.000001) return `$${usd.toFixed(6)}`
  return `$${usd.toExponential(2)}`
}
