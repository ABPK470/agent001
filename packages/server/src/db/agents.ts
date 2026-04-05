/**
 * LLM configuration & agent definition persistence.
 */

import { getDb } from "./connection.js"

// ── LLM config ───────────────────────────────────────────────────

export type LlmProvider = "copilot-chat" | "copilot" | "openai" | "anthropic" | "local"

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
  getDb().prepare(`
    UPDATE llm_config
    SET provider = @provider, model = @model, api_key = @api_key,
        base_url = @base_url, updated_at = datetime('now')
    WHERE id = 1
  `).run(cfg)
}

// ── Agent definition queries ─────────────────────────────────────

export interface DbAgentDefinition {
  id: string
  name: string
  description: string
  system_prompt: string
  tools: string          // JSON array of tool names
  created_at: string
  updated_at: string
}

export function listAgentDefinitions(): DbAgentDefinition[] {
  return getDb()
    .prepare("SELECT * FROM agent_definitions ORDER BY created_at")
    .all() as DbAgentDefinition[]
}

export function getAgentDefinition(id: string): DbAgentDefinition | undefined {
  return getDb()
    .prepare("SELECT * FROM agent_definitions WHERE id = ?")
    .get(id) as DbAgentDefinition | undefined
}

export function saveAgentDefinition(agent: DbAgentDefinition): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO agent_definitions (id, name, description, system_prompt, tools, created_at, updated_at)
    VALUES (@id, @name, @description, @system_prompt, @tools, @created_at, datetime('now'))
  `).run(agent)
}

export function deleteAgentDefinition(id: string): void {
  getDb().prepare("DELETE FROM agent_definitions WHERE id = ?").run(id)
}
