/**
 * Boot-time LLM env → llm_config write (takes an open Database; no getDb).
 */

import type Database from "better-sqlite3"
import {
  llmEnvOptional,
  readLlmEnvOverride,
  type LlmEnvOverride,
} from "../../../llm/env-override.js"

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
  writeLlmEnvOverride(db, override)
  // eslint-disable-next-line no-console
  console.log(`[boot] llm_config set from .env: ${override.provider} / ${override.model}`)
  return true
}

function writeLlmEnvOverride(db: Database.Database, override: LlmEnvOverride): void {
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
  `,
    )
    .run(override)

  if (result.changes === 0) {
    db.prepare(
      `
      INSERT INTO llm_config (id, provider, model, api_key, base_url, updated_at)
      VALUES (1, @provider, @model, @api_key, @base_url, datetime('now'))
    `,
    ).run(override)
  }
}
