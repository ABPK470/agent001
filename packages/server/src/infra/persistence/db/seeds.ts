/**
 * Idempotent data seeds — run on every server boot after schema migrations.
 * Shipped defaults load from deploy/sync artifacts, not TypeScript constants.
 */

import { DEFAULT_SYSTEM_PROMPT, PolicyEffect } from "@mia/agent"
import { loadStrategiesArtifact } from "@mia/sync"
import { createHash } from "node:crypto"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type Database from "better-sqlite3"

const DEFAULT_TENANT = "_default"
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..")

function seedScd2StrategiesFromArtifact(db: Database.Database, projectRoot: string): void {
  const artifact = loadStrategiesArtifact(resolve(projectRoot))
  const seedStrategyPointer = db.prepare(
    `INSERT OR IGNORE INTO scd2_strategies (tenant_id, id, current_version, retired_at)
     VALUES (?, ?, ?, NULL)`,
  )
  const seedStrategyVersion = db.prepare(
    `INSERT OR IGNORE INTO scd2_strategy_versions
       (tenant_id, id, version, body_json, created_by, created_at, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const strategy of artifact.strategies) {
    seedStrategyPointer.run(DEFAULT_TENANT, strategy.id, strategy.version)
    seedStrategyVersion.run(
      DEFAULT_TENANT,
      strategy.id,
      strategy.version,
      JSON.stringify(strategy),
      strategy.createdBy,
      strategy.createdAt,
      "shipped",
    )
  }
}

export function runSeeds(db: Database.Database, projectRoot = REPO_ROOT): void {
  seedScd2StrategiesFromArtifact(db, projectRoot)

  const seededDefaultSha = createHash("sha1").update(DEFAULT_SYSTEM_PROMPT).digest("hex").slice(0, 8)
  const previousDefault = db
    .prepare("SELECT system_prompt FROM agent_definitions WHERE id = 'default'")
    .get() as { system_prompt: string } | undefined
  db.prepare(
    `
    INSERT INTO agent_definitions (id, name, description, system_prompt, created_at, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      system_prompt = excluded.system_prompt,
      name          = excluded.name,
      description   = excluded.description,
      updated_at    = datetime('now')
  `
  ).run(
    "default",
    "Universal Agent",
    "General-purpose agent with all tools. Handles any task.",
    DEFAULT_SYSTEM_PROMPT
  )
  if (previousDefault && previousDefault.system_prompt !== DEFAULT_SYSTEM_PROMPT) {
    const previousSha = createHash("sha1").update(previousDefault.system_prompt).digest("hex").slice(0, 8)
    // eslint-disable-next-line no-console
    console.log(
      `[seed] default agent system_prompt re-synced from file: ${previousSha} → ${seededDefaultSha} ` +
        `(${DEFAULT_SYSTEM_PROMPT.length} bytes). Source: packages/agent/prompts/default-system.md`
    )
  } else {
    // eslint-disable-next-line no-console
    console.log(
      `[seed] default agent system_prompt verified (sha=${seededDefaultSha}, ${DEFAULT_SYSTEM_PROMPT.length} bytes)`
    )
  }

  const seedPolicies: { name: string; effect: PolicyEffect; condition: string; parameters: string }[] = [
    {
      name: "Tool Permission",
      effect: PolicyEffect.Allow,
      condition: "tool_call",
      parameters: JSON.stringify({
        scope: "all_tools",
        description: "Controls which tools agents are permitted to invoke"
      })
    },
    {
      name: "Model",
      effect: PolicyEffect.Allow,
      condition: "model_selection",
      parameters: JSON.stringify({
        scope: "all_models",
        description: "Controls model selection and usage limits"
      })
    },
    {
      name: "Security",
      effect: PolicyEffect.RequireApproval,
      condition: "sensitive_action",
      parameters: JSON.stringify({
        scope: "destructive_ops",
        description: "Requires approval for destructive or sensitive operations"
      })
    }
  ]
  const insertPolicy = db.prepare(`
    INSERT OR IGNORE INTO policy_rules (name, effect, condition, parameters, created_at)
    VALUES (@name, @effect, @condition, @parameters, datetime('now'))
  `)
  for (const p of seedPolicies) insertPolicy.run(p)
}
