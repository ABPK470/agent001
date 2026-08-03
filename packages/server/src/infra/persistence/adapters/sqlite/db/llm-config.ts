/**
 * LLM configuration persistence.
 */

import { getPlatformDb } from "../../../schema/kysely.js"
import { runExecAsync, runGetAsync } from "../../../schema/execute-async.js"
import { platformNow } from "../../../schema/sql-time.js"
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

export async function getLlmConfig(): Promise<DbLlmConfig> {
  const compiled = getPlatformDb()
    .selectFrom("llm_config")
    .select(["provider", "model", "api_key", "base_url", "updated_at"])
    .where("id", "=", 1)
    .compile()
  return await runGetAsync<DbLlmConfig>(compiled) as DbLlmConfig
}

export async function saveLlmConfig(cfg: Omit<DbLlmConfig, "updated_at">): Promise<void> {
  const compiled = getPlatformDb()
    .updateTable("llm_config")
    .set({
      provider: cfg.provider,
      model: cfg.model,
      api_key: cfg.api_key,
      base_url: cfg.base_url,
      updated_at: platformNow(),
    })
    .where("id", "=", 1)
    .compile()
  await runExecAsync(compiled)
}
