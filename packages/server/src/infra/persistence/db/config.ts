/**
 * Layout & policy persistence.
 */

import { PolicyEffect } from "@mia/agent"
import { PolicySource } from "../../../internal/enums/index.js"
import { getDb } from "../connection.js"

export { PolicySource } from "../../../internal/enums/index.js"

// ── Layout queries ───────────────────────────────────────────────

export interface DbLayout {
  id: string
  name: string
  config: string
  updated_at: string
}

export function saveLayout(layout: DbLayout): void {
  getDb()
    .prepare(
      `
    INSERT OR REPLACE INTO layouts (id, name, config, updated_at)
    VALUES (@id, @name, @config, @updated_at)
  `
    )
    .run(layout)
}

export function getLayouts(): DbLayout[] {
  return getDb().prepare("SELECT * FROM layouts ORDER BY updated_at DESC").all() as DbLayout[]
}

export function getLayout(id: string): DbLayout | undefined {
  return getDb().prepare("SELECT * FROM layouts WHERE id = ?").get(id) as DbLayout | undefined
}

export function deleteLayout(id: string): void {
  getDb().prepare("DELETE FROM layouts WHERE id = ?").run(id)
}

// ── Policy rule queries ──────────────────────────────────────────

/**
 * `source` distinguishes how a rule got into the table:
 *   - 'db'             — operator-authored via the admin UI / API.
 *   - 'hosted_default' — seeded from `hostedDefaultPolicyRules()`.
 *   - 'env_derived'    — derived from `policyRulesFromEnvironments()`.
 *
 * Operators can edit/delete any rule; the seeder only re-creates a
 * rule if no row with that `name` exists. Deletes are persistent
 * (operator opt-out is intentional and survives restart).
 */

export interface DbPolicyRule {
  name: string
  effect: PolicyEffect
  condition: string
  parameters: string
  created_at: string
  source?: PolicySource
  updated_at?: string | null
  updated_by?: string | null
}

export function listPolicyRules(): DbPolicyRule[] {
  return getDb().prepare("SELECT * FROM policy_rules ORDER BY created_at").all() as DbPolicyRule[]
}

export function savePolicyRule(rule: DbPolicyRule): void {
  getDb()
    .prepare(
      `
    INSERT OR REPLACE INTO policy_rules (name, effect, condition, parameters, created_at, source, updated_at, updated_by)
    VALUES (@name, @effect, @condition, @parameters, @created_at, @source, @updated_at, @updated_by)
  `
    )
    .run({
      source: rule.source ?? PolicySource.Db,
      updated_at: rule.updated_at ?? null,
      updated_by: rule.updated_by ?? null,
      ...rule
    })
}

/**
 * Insert a rule only if no row with that name already exists. Used by
 * the seeder so re-running boot doesn't trample operator edits.
 */
export function seedPolicyRuleIfMissing(rule: DbPolicyRule): boolean {
  const result = getDb()
    .prepare(
      `
    INSERT OR IGNORE INTO policy_rules (name, effect, condition, parameters, created_at, source, updated_at, updated_by)
    VALUES (@name, @effect, @condition, @parameters, @created_at, @source, NULL, NULL)
  `
    )
    .run({
      source: rule.source ?? PolicySource.HostedDefault,
      ...rule
    })
  return result.changes > 0
}

export function deletePolicyRule(name: string): void {
  getDb().prepare("DELETE FROM policy_rules WHERE name = ?").run(name)
}

// ── Sync-environment override queries ────────────────────────────

export interface DbSyncEnvOverride {
  name: string
  overrides_json: string
  updated_at: string
  updated_by: string | null
}

export interface DbSyncEnvironment {
  name: string
  body_json: string
  created_at: string
  updated_at: string
  updated_by: string | null
}

export interface DbSyncDefinitionConfig {
  tenant_id: string
  entity_id: string
  flow_preset: string
  execution_steps_json: string
  service_profile_ref: string
  environment_policy_ref: string
  ownership_team: string
  ownership_owner: string | null
  review_status: "legacy-review-required" | "reviewed"
  ownership_notes_json: string
  updated_at: string
  updated_by: string | null
}

export function listSyncEnvOverrides(): DbSyncEnvOverride[] {
  return getDb()
    .prepare("SELECT * FROM sync_environment_overrides ORDER BY name")
    .all() as DbSyncEnvOverride[]
}

export function getSyncEnvOverride(name: string): DbSyncEnvOverride | undefined {
  return getDb().prepare("SELECT * FROM sync_environment_overrides WHERE name = ?").get(name) as
    | DbSyncEnvOverride
    | undefined
}

export function saveSyncEnvOverride(row: DbSyncEnvOverride): void {
  getDb()
    .prepare(
      `
    INSERT OR REPLACE INTO sync_environment_overrides (name, overrides_json, updated_at, updated_by)
    VALUES (@name, @overrides_json, @updated_at, @updated_by)
  `
    )
    .run(row)
}

export function deleteSyncEnvOverride(name: string): void {
  getDb().prepare("DELETE FROM sync_environment_overrides WHERE name = ?").run(name)
}

export function countSyncEnvironments(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS count FROM sync_environments").get() as { count: number }
  return row.count
}

export function listSyncEnvironments(): DbSyncEnvironment[] {
  return getDb().prepare("SELECT * FROM sync_environments ORDER BY name").all() as DbSyncEnvironment[]
}

export function getSyncEnvironment(name: string): DbSyncEnvironment | undefined {
  return getDb().prepare("SELECT * FROM sync_environments WHERE name = ?").get(name) as
    | DbSyncEnvironment
    | undefined
}

export function saveSyncEnvironment(row: DbSyncEnvironment): void {
  getDb()
    .prepare(
      `
    INSERT OR REPLACE INTO sync_environments (name, body_json, created_at, updated_at, updated_by)
    VALUES (@name, @body_json, COALESCE((SELECT created_at FROM sync_environments WHERE name = @name), @created_at), @updated_at, @updated_by)
  `
    )
    .run(row)
}

export function deleteSyncEnvironment(name: string): void {
  getDb().prepare("DELETE FROM sync_environments WHERE name = ?").run(name)
}

export function countSyncDefinitionConfigs(tenantId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS count FROM sync_definition_configs WHERE tenant_id = ?")
    .get(tenantId) as { count: number }
  return row.count
}

export function listSyncDefinitionConfigs(tenantId: string): DbSyncDefinitionConfig[] {
  return getDb()
    .prepare("SELECT * FROM sync_definition_configs WHERE tenant_id = ? ORDER BY entity_id")
    .all(tenantId) as DbSyncDefinitionConfig[]
}

export function getSyncDefinitionConfig(
  tenantId: string,
  entityId: string
): DbSyncDefinitionConfig | undefined {
  return getDb()
    .prepare("SELECT * FROM sync_definition_configs WHERE tenant_id = ? AND entity_id = ?")
    .get(tenantId, entityId) as DbSyncDefinitionConfig | undefined
}

export function saveSyncDefinitionConfig(row: DbSyncDefinitionConfig): void {
  getDb()
    .prepare(
      `
    INSERT OR REPLACE INTO sync_definition_configs (
      tenant_id,
      entity_id,
      flow_preset,
      execution_steps_json,
      service_profile_ref,
      environment_policy_ref,
      ownership_team,
      ownership_owner,
      review_status,
      ownership_notes_json,
      updated_at,
      updated_by
    ) VALUES (
      @tenant_id,
      @entity_id,
      @flow_preset,
      @execution_steps_json,
      @service_profile_ref,
      @environment_policy_ref,
      @ownership_team,
      @ownership_owner,
      @review_status,
      @ownership_notes_json,
      @updated_at,
      @updated_by
    )
  `
    )
    .run(row)
}

export function deleteSyncDefinitionConfig(tenantId: string, entityId: string): void {
  getDb()
    .prepare("DELETE FROM sync_definition_configs WHERE tenant_id = ? AND entity_id = ?")
    .run(tenantId, entityId)
}
