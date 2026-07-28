/**
 * Parse `LLM_PROVIDER` + `LLM_MODEL` from `.env`.
 * SQLite writes live in the adapter (`applyLlmEnvOverride` in llm-config).
 */

import { isLlmProvider, LlmProvider, type LlmProvider as LlmProviderId } from "../../internal/enums/llm.js"
import { PROVIDER_DEFAULTS } from "./provider-defaults.js"

export interface LlmEnvOverride {
  provider: LlmProviderId
  model: string
  api_key: string
  base_url: string
}

export function llmEnvOptional(): boolean {
  return process.env["MIA_SKIP_SETUP"] === "1" || process.env["MIA_SKIP_SETUP"] === "true"
}

/** Parse `.env` LLM settings. Returns null when `LLM_PROVIDER` is unset. */
export function readLlmEnvOverride(): LlmEnvOverride | null {
  const rawProvider = process.env["LLM_PROVIDER"]?.trim()
  if (!rawProvider) return null

  if (!isLlmProvider(rawProvider)) {
    throw new Error(
      `Invalid LLM_PROVIDER="${rawProvider}". Allowed: ${Object.values(LlmProvider).join(", ")}.`,
    )
  }

  const defaults = PROVIDER_DEFAULTS[rawProvider]
  const model = process.env["LLM_MODEL"]?.trim() || defaults.model
  const api_key = process.env["LLM_API_KEY"]?.trim() ?? ""
  const base_url = process.env["LLM_BASE_URL"]?.trim() ?? defaults.baseUrl

  return { provider: rawProvider, model, api_key, base_url }
}
