/**
 * Layout & policy persistence.
 */

import { PolicyEffect } from "@mia/agent"
import { sql } from "kysely"
import { PolicySource } from "../../../../../internal/enums/index.js"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runAll, runExec, runGet } from "../../../schema/execute.js"
import { insertRowOrIgnore, upsertRow } from "../../../schema/upsert.js"

export { PolicySource } from "../../../../../internal/enums/index.js"

// ── Layout queries ───────────────────────────────────────────────

export interface DbLayout {
  id: string
  name: string
  config: string
  updated_at: string
}

export function saveLayout(layout: DbLayout): void {
  upsertRow({
    table: "layout_configs",
    keys: { id: layout.id },
    insert: layout,
    update: {
      name: layout.name,
      config: layout.config,
      updated_at: layout.updated_at,
    },
  })
}

export function getLayouts(): DbLayout[] {
  const compiled = getPlatformDb()
    .selectFrom("layout_configs")
    .selectAll()
    .orderBy("updated_at", "desc")
    .compile()
  return runAll<DbLayout>(compiled)
}

export function getLayout(id: string): DbLayout | undefined {
  const compiled = getPlatformDb()
    .selectFrom("layout_configs")
    .selectAll()
    .where("id", "=", id)
    .compile()
  return runGet<DbLayout>(compiled)
}

export function deleteLayout(id: string): void {
  const compiled = getPlatformDb()
    .deleteFrom("layout_configs")
    .where("id", "=", id)
    .compile()
  runExec(compiled)
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
  const compiled = getPlatformDb()
    .selectFrom("policy_configs")
    .selectAll()
    .orderBy("created_at")
    .compile()
  return runAll<DbPolicyRule>(compiled)
}

export function savePolicyRule(rule: DbPolicyRule): void {
  const source = rule.source ?? PolicySource.Db
  const updatedAt = rule.updated_at ?? null
  const updatedBy = rule.updated_by ?? null
  const row = {
    name: rule.name,
    effect: rule.effect,
    condition: rule.condition,
    parameters: rule.parameters,
    created_at: rule.created_at,
    source,
    updated_at: updatedAt,
    updated_by: updatedBy,
  }
  upsertRow({
    table: "policy_configs",
    keys: { name: rule.name },
    insert: row,
    update: {
      effect: rule.effect,
      condition: rule.condition,
      parameters: rule.parameters,
      created_at: rule.created_at,
      source,
      updated_at: updatedAt,
      updated_by: updatedBy,
    },
  })
}

/**
 * Insert a rule only if no row with that name already exists. Used by
 * the seeder so re-running boot doesn't trample operator edits.
 */
export function seedPolicyRuleIfMissing(rule: DbPolicyRule): boolean {
  const source = rule.source ?? PolicySource.HostedDefault
  return insertRowOrIgnore({
    table: "policy_configs",
    keys: { name: rule.name },
    insert: {
      name: rule.name,
      effect: rule.effect,
      condition: rule.condition,
      parameters: rule.parameters,
      created_at: rule.created_at,
      source,
      updated_at: null,
      updated_by: null,
    },
  })
}

export function deletePolicyRule(name: string): void {
  const compiled = getPlatformDb()
    .deleteFrom("policy_configs")
    .where("name", "=", name)
    .compile()
  runExec(compiled)
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
  const compiled = getPlatformDb()
    .selectFrom("sync_environment_override_configs")
    .selectAll()
    .orderBy("name")
    .compile()
  return runAll<DbSyncEnvOverride>(compiled)
}

export function getSyncEnvOverride(name: string): DbSyncEnvOverride | undefined {
  const compiled = getPlatformDb()
    .selectFrom("sync_environment_override_configs")
    .selectAll()
    .where("name", "=", name)
    .compile()
  return runGet<DbSyncEnvOverride>(compiled)
}

export function saveSyncEnvOverride(row: DbSyncEnvOverride): void {
  upsertRow({
    table: "sync_environment_override_configs",
    keys: { name: row.name },
    insert: row,
    update: {
      overrides_json: row.overrides_json,
      updated_at: row.updated_at,
      updated_by: row.updated_by,
    },
  })
}

export function deleteSyncEnvOverride(name: string): void {
  const compiled = getPlatformDb()
    .deleteFrom("sync_environment_override_configs")
    .where("name", "=", name)
    .compile()
  runExec(compiled)
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
