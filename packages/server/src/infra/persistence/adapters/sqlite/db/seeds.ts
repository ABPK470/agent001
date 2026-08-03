/**
 * Idempotent data seeds — run on every server boot after schema migrations.
 * Shipped defaults load from deploy/sync artifacts, not TypeScript constants.
 * Uses the platform schema toolkit (portable across dialects).
 */

import { PolicyEffect } from "@mia/agent"
import { loadStrategiesArtifact } from "@mia/sync"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { PolicySource } from "../../../../../internal/enums/index.js"
import { getPlatformDb } from "../../../schema/kysely.js"
import { insertRowOrIgnore } from "../../../schema/upsert.js"

const DEFAULT_TENANT = "_default"
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../../../..")

function seedScd2StrategiesFromArtifact(projectRoot: string): void {
  const artifact = loadStrategiesArtifact(resolve(projectRoot))
  const now = new Date().toISOString()
  for (const strategy of artifact.strategies) {
    insertRowOrIgnore({
      table: "scd2_strategy_active",
      keys: { tenant_id: DEFAULT_TENANT, id: strategy.id },
      insert: {
        tenant_id: DEFAULT_TENANT,
        id: strategy.id,
        current_version: strategy.version,
        retired_at: null,
      },
    })
    insertRowOrIgnore({
      table: "scd2_strategy_versions",
      keys: {
        tenant_id: DEFAULT_TENANT,
        id: strategy.id,
        version: strategy.version,
      },
      insert: {
        tenant_id: DEFAULT_TENANT,
        id: strategy.id,
        version: strategy.version,
        body_json: JSON.stringify(strategy),
        created_by: strategy.createdBy,
        created_at: strategy.createdAt ?? now,
        reason: "shipped",
      },
    })
  }
}

export function runSeeds(projectRoot = REPO_ROOT): void {
  // Ensure Kysely is bound to the open connection before seeding.
  getPlatformDb()
  seedScd2StrategiesFromArtifact(projectRoot)

  const seedPolicies: { name: string; effect: PolicyEffect; condition: string; parameters: string }[] = [
    {
      name: "Tool Permission",
      effect: PolicyEffect.Allow,
      condition: "tool_call",
      parameters: JSON.stringify({
        scope: "all_tools",
        description: "Controls which tools agents are permitted to invoke",
      }),
    },
    {
      name: "Model",
      effect: PolicyEffect.Allow,
      condition: "model_selection",
      parameters: JSON.stringify({
        scope: "all_models",
        description: "Controls model selection and usage limits",
      }),
    },
    {
      name: "Security",
      effect: PolicyEffect.RequireApproval,
      condition: "sensitive_action",
      parameters: JSON.stringify({
        scope: "destructive_ops",
        description: "Requires approval for destructive or sensitive operations",
      }),
    },
  ]
  const now = new Date().toISOString()
  for (const p of seedPolicies) {
    insertRowOrIgnore({
      table: "policy_configs",
      keys: { name: p.name },
      insert: {
        name: p.name,
        effect: p.effect,
        condition: p.condition,
        parameters: p.parameters,
        created_at: now,
        source: PolicySource.HostedDefault,
        updated_at: null,
        updated_by: null,
      },
    })
  }
}
