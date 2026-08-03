/**
 * Layout & policy persistence.
 */

import { PolicyEffect } from "@mia/agent"
import { sql } from "kysely"
import { PolicySource } from "../../../../../internal/enums/index.js"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runAllAsync, runExecAsync, runGetAsync } from "../../../schema/execute-async.js"
import { insertRowOrIgnoreAsync, upsertRowAsync } from "../../../schema/upsert.js"

export { PolicySource } from "../../../../../internal/enums/index.js"

// ── Layout queries ───────────────────────────────────────────────

export interface DbLayout {
  id: string
  name: string
  config: string
  updated_at: string
}

export async function saveLayout(layout: DbLayout): Promise<void> {
  await upsertRowAsync({
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

export async function getLayouts(): Promise<DbLayout[]> {
  const compiled = getPlatformDb()
    .selectFrom("layout_configs")
    .selectAll()
    .orderBy("updated_at", "desc")
    .compile()
  return await runAllAsync<DbLayout>(compiled)
}

export async function getLayout(id: string): Promise<DbLayout | undefined> {
  const compiled = getPlatformDb()
    .selectFrom("layout_configs")
    .selectAll()
    .where("id", "=", id)
    .compile()
  return await runGetAsync<DbLayout>(compiled)
}

export async function deleteLayout(id: string): Promise<void> {
  const compiled = getPlatformDb()
    .deleteFrom("layout_configs")
    .where("id", "=", id)
    .compile()
  await runExecAsync(compiled)
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

export async function listPolicyRules(): Promise<DbPolicyRule[]> {
  const compiled = getPlatformDb()
    .selectFrom("policy_configs")
    .selectAll()
    .orderBy("created_at")
    .compile()
  return await runAllAsync<DbPolicyRule>(compiled)
}

export async function savePolicyRule(rule: DbPolicyRule): Promise<void> {
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
  await upsertRowAsync({
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
export async function seedPolicyRuleIfMissing(rule: DbPolicyRule): Promise<boolean> {
  const source = rule.source ?? PolicySource.HostedDefault
  return await insertRowOrIgnoreAsync({
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

export async function deletePolicyRule(name: string): Promise<void> {
  const compiled = getPlatformDb()
    .deleteFrom("policy_configs")
    .where("name", "=", name)
    .compile()
  await runExecAsync(compiled)
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

export async function listSyncEnvOverrides(): Promise<DbSyncEnvOverride[]> {
  const compiled = getPlatformDb()
    .selectFrom("sync_environment_override_configs")
    .selectAll()
    .orderBy("name")
    .compile()
  return await runAllAsync<DbSyncEnvOverride>(compiled)
}

export async function getSyncEnvOverride(name: string): Promise<DbSyncEnvOverride | undefined> {
  const compiled = getPlatformDb()
    .selectFrom("sync_environment_override_configs")
    .selectAll()
    .where("name", "=", name)
    .compile()
  return await runGetAsync<DbSyncEnvOverride>(compiled)
}

export async function saveSyncEnvOverride(row: DbSyncEnvOverride): Promise<void> {
  await upsertRowAsync({
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

export async function deleteSyncEnvOverride(name: string): Promise<void> {
  const compiled = getPlatformDb()
    .deleteFrom("sync_environment_override_configs")
    .where("name", "=", name)
    .compile()
  await runExecAsync(compiled)
}

export async function countSyncEnvironments(): Promise<number> {
  const compiled = getPlatformDb()
    .selectFrom("sync_environments")
    .select(sql<number>`count(*)`.as("count"))
    .compile()
  const row = await runGetAsync<{ count: number | bigint }>(compiled)
  return Number(row?.count ?? 0)
}

export async function listSyncEnvironments(): Promise<DbSyncEnvironment[]> {
  const compiled = getPlatformDb()
    .selectFrom("sync_environments")
    .selectAll()
    .orderBy("name")
    .compile()
  return await runAllAsync<DbSyncEnvironment>(compiled)
}

export async function getSyncEnvironment(name: string): Promise<DbSyncEnvironment | undefined> {
  const compiled = getPlatformDb()
    .selectFrom("sync_environments")
    .selectAll()
    .where("name", "=", name)
    .compile()
  return await runGetAsync<DbSyncEnvironment>(compiled)
}

export async function saveSyncEnvironment(row: DbSyncEnvironment): Promise<void> {
  const existing = await getSyncEnvironment(row.name)
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
    await runExecAsync(compiled)
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
  await runExecAsync(compiled)
}

export async function deleteSyncEnvironment(name: string): Promise<void> {
  const compiled = getPlatformDb()
    .deleteFrom("sync_environments")
    .where("name", "=", name)
    .compile()
  await runExecAsync(compiled)
}
