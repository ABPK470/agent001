/**
 * Layout & policy persistence.
 */

import { PolicyEffect } from "@mia/agent"
import { sql } from "kysely"
import { PolicySource } from "../../../../../internal/enums/index.js"
import { getDb } from "../connection.js"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runAll, runExec, runGet } from "../../../schema/execute.js"

export { PolicySource } from "../../../../../internal/enums/index.js"

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
    INSERT OR REPLACE INTO layout_configs (id, name, config, updated_at)
    VALUES (@id, @name, @config, @updated_at)
  `
    )
    .run(layout)
}

export function getLayouts(): DbLayout[] {
  return getDb().prepare("SELECT * FROM layout_configs ORDER BY updated_at DESC").all() as DbLayout[]
}

export function getLayout(id: string): DbLayout | undefined {
  return getDb().prepare("SELECT * FROM layout_configs WHERE id = ?").get(id) as DbLayout | undefined
}

export function deleteLayout(id: string): void {
  getDb().prepare("DELETE FROM layout_configs WHERE id = ?").run(id)
}

// ── Policy rule queries ──────────────────────────────────────────

/**
 * `source` distinguishes how a rule got into the table:
 *   - 'db'             — operator-authored via the admin UI / API.
 *   - 'hosted_default' — seeded from `deploy/policies/defaults.json`.
 *   - 'env_derived'    — obsolete leftover; cleared on boot / factory reset.
 *
 * Operators can edit/delete any rule; boot only inserts when a `name` is
 * missing. Factory reset (Platform) re-reads the JSON on purpose.
 * Deletes of factory names survive restart until that explicit reset.
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
  return getDb().prepare("SELECT * FROM policy_configs ORDER BY created_at").all() as DbPolicyRule[]
}

export function savePolicyRule(rule: DbPolicyRule): void {
  getDb()
    .prepare(
      `
    INSERT OR REPLACE INTO policy_configs (name, effect, condition, parameters, created_at, source, updated_at, updated_by)
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
    INSERT OR IGNORE INTO policy_configs (name, effect, condition, parameters, created_at, source, updated_at, updated_by)
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
  getDb().prepare("DELETE FROM policy_configs WHERE name = ?").run(name)
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

export function listSyncEnvOverrides(): DbSyncEnvOverride[] {
  return getDb()
    .prepare("SELECT * FROM sync_environment_override_configs ORDER BY name")
    .all() as DbSyncEnvOverride[]
}

export function getSyncEnvOverride(name: string): DbSyncEnvOverride | undefined {
  return getDb().prepare("SELECT * FROM sync_environment_override_configs WHERE name = ?").get(name) as
    | DbSyncEnvOverride
    | undefined
}

export function saveSyncEnvOverride(row: DbSyncEnvOverride): void {
  getDb()
    .prepare(
      `
    INSERT OR REPLACE INTO sync_environment_override_configs (name, overrides_json, updated_at, updated_by)
    VALUES (@name, @overrides_json, @updated_at, @updated_by)
  `
    )
    .run(row)
}

export function deleteSyncEnvOverride(name: string): void {
  getDb().prepare("DELETE FROM sync_environment_override_configs WHERE name = ?").run(name)
}

export function countSyncEnvironments(): number {
  const compiled = getPlatformDb()
    .selectFrom("sync_environments")
    .select(sql<number>`count(*)`.as("count"))
    .compile()
  const row = runGet<{ count: number | bigint }>(compiled)
  return Number(row?.count ?? 0)
}

export function listSyncEnvironments(): DbSyncEnvironment[] {
  const compiled = getPlatformDb()
    .selectFrom("sync_environments")
    .selectAll()
    .orderBy("name")
    .compile()
  return runAll<DbSyncEnvironment>(compiled)
}

export function getSyncEnvironment(name: string): DbSyncEnvironment | undefined {
  const compiled = getPlatformDb()
    .selectFrom("sync_environments")
    .selectAll()
    .where("name", "=", name)
    .compile()
  return runGet<DbSyncEnvironment>(compiled)
}

export function saveSyncEnvironment(row: DbSyncEnvironment): void {
  const existing = getSyncEnvironment(row.name)
  if (existing) {
    const compiled = getPlatformDb()
      .updateTable("sync_environments")
      .set({
        body_json: row.body_json,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
      })
      .where("name", "=", row.name)
      .compile()
    runExec(compiled)
    return
  }
  const compiled = getPlatformDb()
    .insertInto("sync_environments")
    .values({
      name: row.name,
      body_json: row.body_json,
      created_at: row.created_at,
      updated_at: row.updated_at,
      updated_by: row.updated_by,
    })
    .compile()
  runExec(compiled)
}

export function deleteSyncEnvironment(name: string): void {
  const compiled = getPlatformDb()
    .deleteFrom("sync_environments")
    .where("name", "=", name)
    .compile()
  runExec(compiled)
}
