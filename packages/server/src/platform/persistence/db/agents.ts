/**
 * LLM configuration & agent definition persistence.
 */

import { DEFAULT_SYSTEM_PROMPT } from "@mia/agent"
import { getDb } from "./connection.js"
import { LlmProvider } from "../../../shared/enums/llm.js"

// ── LLM config ───────────────────────────────────────────────────

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

// ── Agent definition queries ─────────────────────────────────────

export interface DbAgentDefinition {
  id: string
  name: string
  description: string
  system_prompt: string
  created_at: string
  updated_at: string
}

export function listAgentDefinitions(): DbAgentDefinition[] {
  return getDb().prepare("SELECT * FROM agent_definitions ORDER BY created_at").all() as DbAgentDefinition[]
}

export function getAgentDefinition(id: string): DbAgentDefinition | undefined {
  return getDb().prepare("SELECT * FROM agent_definitions WHERE id = ?").get(id) as
    | DbAgentDefinition
    | undefined
}

export function saveAgentDefinition(agent: DbAgentDefinition): void {
  getDb()
    .prepare(
      `
    INSERT OR REPLACE INTO agent_definitions (id, name, description, system_prompt, created_at, updated_at)
    VALUES (@id, @name, @description, @system_prompt, @created_at, datetime('now'))
  `
    )
    .run(agent)
}

export function deleteAgentDefinition(id: string): void {
  getDb().prepare("DELETE FROM agent_definitions WHERE id = ?").run(id)
}

/**
 * Runtime-effective system prompt for an agent definition.
 *
 * The "default" (Universal) agent is FILE-MANAGED: its prompt always comes
 * from `packages/agent/prompts/default-system.md` (DEFAULT_SYSTEM_PROMPT)
 * regardless of what is stored in the DB. The stored row is a display-only
 * mirror that gets re-synced on every server startup
 * (see `db/connection.ts` seed).
 *
 * Custom agents (any non-"default" id) ARE persisted — that is the whole
 * point of letting an operator fork a prompt — and their stored prompt is
 * returned verbatim.
 *
 * Use this helper at every API/orchestrator boundary that passes a stored
 * agent prompt into a run, so a stale or out-of-band-edited DB row can
 * never reach the LLM for the default agent.
 */
export function resolveAgentSystemPrompt(def: { id: string; system_prompt: string }): string {
  return def.id === "default" ? DEFAULT_SYSTEM_PROMPT : def.system_prompt
}
