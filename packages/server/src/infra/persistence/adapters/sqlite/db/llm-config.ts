/**
 * LLM configuration persistence.
 */

import { sql } from "kysely"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runExec, runGet } from "../../../schema/execute.js"
import { LlmProvider } from "../../../../../internal/enums/llm.js"

export { LlmProvider }
export { applyLlmEnvOverride } from "../llm-env-bootstrap.js"

export interface DbLlmConfig {
  provider: LlmProvider
  model: string
  api_key: string
  base_url: string
  updated_at: string
}

export function getLlmConfig(): DbLlmConfig {
  const compiled = getPlatformDb()
    .selectFrom("llm_config")
    .select(["provider", "model", "api_key", "base_url", "updated_at"])
    .where("id", "=", 1)
    .compile()
  return runGet<DbLlmConfig>(compiled) as DbLlmConfig
}

export function saveLlmConfig(cfg: Omit<DbLlmConfig, "updated_at">): void {
  const compiled = getPlatformDb()
    .updateTable("llm_config")
    .set({
      provider: cfg.provider,
      model: cfg.model,
      api_key: cfg.api_key,
      base_url: cfg.base_url,
      updated_at: sql`datetime('now')`,
    })
    .where("id", "=", 1)
    .compile()
  runExec(compiled)
}
