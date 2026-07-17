/**
 * Apply `LLM_PROVIDER` + `LLM_MODEL` from `.env` into the singleton `llm_config` row.
 *
 * - copilot-chat: LLM_MODEL is the Copilot model id (default gpt-5.4)
 * - databricks:   LLM_MODEL is the serving endpoint name (default databricks-gpt-5-4)
 *
 * Unset LLM_MODEL → provider default from registry.
 */

import type Database from "better-sqlite3"
import { isLlmProvider, LlmProvider, type LlmProvider as LlmProviderId } from "../../shared/enums/llm.js"
import { PROVIDER_DEFAULTS } from "./registry.js"

export interface LlmEnvOverride {
  provider: LlmProviderId
  model: string
  api_key: string
  base_url: string
}

function llmEnvOptional(): boolean {
  return process.env["MIA_SKIP_SETUP"] === "1" || process.env["MIA_SKIP_SETUP"] === "true"
}

/** Parse `.env` LLM settings. Returns null when `LLM_PROVIDER` is unset. */
export function readLlmEnvOverride(): LlmEnvOverride | null {
  const rawProvider = process.env["LLM_PROVIDER"]?.trim()
  if (!rawProvider) return null

  if (!isLlmProvider(rawProvider)) {
    throw new Error(
      `Invalid LLM_PROVIDER="${rawProvider}". Allowed: ${Object.values(LlmProvider).join(", ")}.`
    )
  }

  const defaults = PROVIDER_DEFAULTS[rawProvider]
  const model = process.env["LLM_MODEL"]?.trim() || defaults.model
  const api_key = process.env["LLM_API_KEY"]?.trim() ?? ""
  const base_url = process.env["LLM_BASE_URL"]?.trim() ?? defaults.baseUrl

  return { provider: rawProvider, model, api_key, base_url }
}

/**
 * Copy `LLM_PROVIDER` from `.env` into `llm_config` id=1.
 * Required on server boot unless `MIA_SKIP_SETUP=1` (tests/CI).
 */
export function applyLlmEnvOverride(db: Database.Database): boolean {
  const override = readLlmEnvOverride()
  if (!override) {
    if (llmEnvOptional()) return false
    throw new Error(
      "LLM_PROVIDER is not set in .env — run npm run setup or set LLM_PROVIDER=copilot-chat|databricks",
    )
  }

  const result = db
    .prepare(
      `
    UPDATE llm_config
       SET provider = @provider,
           model = @model,
           api_key = @api_key,
           base_url = @base_url,
           updated_at = datetime('now')
     WHERE id = 1
  `
    )
    .run(override)

  if (result.changes === 0) {
    db.prepare(
      `
      INSERT INTO llm_config (id, provider, model, api_key, base_url, updated_at)
      VALUES (1, @provider, @model, @api_key, @base_url, datetime('now'))
    `
    ).run(override)
  }

  // eslint-disable-next-line no-console
  console.log(`[boot] llm_config set from .env: ${override.provider} / ${override.model}`)
  return true
}
