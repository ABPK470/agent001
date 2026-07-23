/**
 * LLM configuration persistence.
 */

import { getDb } from "../connection.js"
import { LlmProvider } from "../../../internal/enums/llm.js"

export { LlmProvider }

export interface DbLlmConfig {
  provider: LlmProvider
  model: string
  api_key: string
  base_url: string
  updated_at: string
}

export function getLlmConfig(): DbLlmConfig {
  return getDb()
    .prepare("SELECT provider, model, api_key, base_url, updated_at FROM llm_config WHERE id = 1")
    .get() as DbLlmConfig
}

export function saveLlmConfig(cfg: Omit<DbLlmConfig, "updated_at">): void {
  getDb()
    .prepare(
      `
    UPDATE llm_config
    SET provider = @provider, model = @model, api_key = @api_key,
        base_url = @base_url, updated_at = datetime('now')
    WHERE id = 1
  `
    )
    .run(cfg)
}
