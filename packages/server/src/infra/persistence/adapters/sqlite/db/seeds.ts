/**
 * Idempotent data seeds — run on every server boot after schema migrations.
 * Shipped defaults load from deploy/sync artifacts, not TypeScript constants.
 */

import { PolicyEffect } from "@mia/agent"
import { loadStrategiesArtifact } from "@mia/sync"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type Database from "better-sqlite3"

const DEFAULT_TENANT = "_default"
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..")

function seedScd2StrategiesFromArtifact(db: Database.Database, projectRoot: string): void {
  const artifact = loadStrategiesArtifact(resolve(projectRoot))
  const seedStrategyPointer = db.prepare(
    `INSERT OR IGNORE INTO scd2_strategy_active (tenant_id, id, current_version, retired_at)
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
    INSERT OR IGNORE INTO policy_configs (name, effect, condition, parameters, created_at)
    VALUES (@name, @effect, @condition, @parameters, datetime('now'))
  `)
  for (const p of seedPolicies) insertPolicy.run(p)
}
