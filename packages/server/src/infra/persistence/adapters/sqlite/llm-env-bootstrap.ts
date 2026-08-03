/**
 * Boot-time LLM env → llm_config write via the platform schema toolkit.
 * Sync path — runs inside sqlite open/migrate before the HTTP server starts.
 */

import {
  llmEnvOptional,
  readLlmEnvOverride,
  type LlmEnvOverride,
} from "../../../llm/env-override.js"
import { getPlatformDb } from "../../schema/kysely.js"
import { runChanges, runExec } from "../../schema/execute.js"
import { platformNow } from "../../schema/sql-time.js"

/**
 * Copy `LLM_PROVIDER` from `.env` into `llm_config` id=1.
 * Required on server boot unless `MIA_SKIP_SETUP=1` (tests/CI).
 */
export function applyLlmEnvOverride(): boolean {
  const override = readLlmEnvOverride()
  if (!override) {
    if (llmEnvOptional()) return false
    throw new Error(
      "LLM_PROVIDER is not set in .env — run npm run setup or set LLM_PROVIDER=copilot-chat|databricks",
    )
  }
  writeLlmEnvOverride(override)
  // eslint-disable-next-line no-console
  console.log(`[boot] llm_config set from .env: ${override.provider} / ${override.model}`)
  return true
}

function writeLlmEnvOverride(override: LlmEnvOverride): void {
  getPlatformDb()
  const updated = runChanges(
    getPlatformDb()
      .updateTable("llm_config")
      .set({
        provider: override.provider,
        model: override.model,
        api_key: override.api_key,
        base_url: override.base_url,
        updated_at: platformNow(),
      })
      .where("id", "=", 1)
      .compile(),
  )
  if (updated > 0) return
  runExec(
    getPlatformDb()
      .insertInto("llm_config")
      .values({
        id: 1,
        provider: override.provider,
        model: override.model,
        api_key: override.api_key,
        base_url: override.base_url,
        updated_at: platformNow(),
      })
      .compile(),
  )
}
