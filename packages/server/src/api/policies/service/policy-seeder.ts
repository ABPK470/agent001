/**
 * Policy seeding glue.
 *
 * Factory defaults live in `deploy/policies/defaults.json` — same dialect as
 * connectors and sync-environments. Boot inserts missing names only. After
 * that, the DB (Policies UI) is the source of truth. Never silent-refresh on
 * boot; operators restore factory rows only via explicit Platform reset.
 */

import * as db from "../../../infra/persistence/sqlite.js"
import { loadPolicyDefaults, POLICY_DEFAULTS_SEED_PATH } from "./load-policy-defaults.js"

export interface PolicySeedResult {
  inserted: number
  clearedEnvDerived: number
}

export interface PolicyFactoryResetResult {
  removed: number
  inserted: number
  clearedEnvDerived: number
  seedPath: string
}

/**
 * Insert each factory default only when that rule name is missing.
 * Existing rows (any source) are left untouched — including old
 * `hosted_default` rows an operator never edited.
 */
export function seedDefaultPoliciesIfMissing(projectRoot: string): PolicySeedResult {
  const { rules } = loadPolicyDefaults(projectRoot)
  const now = new Date().toISOString()
  let inserted = 0

  for (const r of rules) {
    const didInsert = db.seedPolicyRuleIfMissing({
      name: r.name,
      effect: r.effect,
      condition: r.condition,
      parameters: JSON.stringify(r.parameters ?? {}),
      created_at: now,
      source: db.PolicySource.HostedDefault,
    })
    if (didInsert) inserted++
  }

  const clearedEnvDerived = clearAllEnvDerivedPolicies()
  if (inserted || clearedEnvDerived) {
    console.log(
      `[policy-seeder] seeded ${inserted} missing default(s) from ${POLICY_DEFAULTS_SEED_PATH}; cleared ${clearedEnvDerived} env_derived leftover(s)`,
    )
  }
  return { inserted, clearedEnvDerived }
}

/**
 * Explicit Platform action: re-read `deploy/policies/defaults.json` and replace
 * every factory-named row (plus leftover `hosted_default` / `env_derived`).
 * Operator rules with names outside the factory set are preserved.
 */
export function resetFactoryPolicyDefaults(projectRoot: string): PolicyFactoryResetResult {
  const { rules } = loadPolicyDefaults(projectRoot)
  const factoryNames = new Set(rules.map((r) => r.name))
  let removed = 0

  for (const row of db.listPolicyRules()) {
    if (row.source === db.PolicySource.HostedDefault || factoryNames.has(row.name)) {
      db.deletePolicyRule(row.name)
      removed++
    }
  }

  const clearedEnvDerived = clearAllEnvDerivedPolicies()
  const now = new Date().toISOString()
  let inserted = 0
  for (const r of rules) {
    db.savePolicyRule({
      name: r.name,
      effect: r.effect,
      condition: r.condition,
      parameters: JSON.stringify(r.parameters ?? {}),
      created_at: now,
      source: db.PolicySource.HostedDefault,
      updated_at: null,
      updated_by: null,
    })
    inserted++
  }

  console.log(
    `[policy-seeder] reset factory defaults from ${POLICY_DEFAULTS_SEED_PATH}: removed ${removed}, inserted ${inserted}, cleared ${clearedEnvDerived} env_derived`,
  )
  return {
    removed,
    inserted,
    clearedEnvDerived,
    seedPath: POLICY_DEFAULTS_SEED_PATH,
  }
}

/** Drop every env_derived rule (Access is no longer a policy editor). */
export function clearAllEnvDerivedPolicies(): number {
  const existing = db.listPolicyRules().filter((r) => r.source === db.PolicySource.EnvDerived)
  for (const r of existing) db.deletePolicyRule(r.name)
  return existing.length
}

/**
 * After an admin edits env config, drop leftover `env_derived` rules for
 * that env name. Does not re-insert — Policies are the sole governance rail.
 */
export function refreshEnvDerivedPolicies(_host: unknown, envName: string): void {
  const prefix = `env_${envName}_`
  const existing = db
    .listPolicyRules()
    .filter((r) => r.source === db.PolicySource.EnvDerived && r.name.startsWith(prefix))
  for (const r of existing) db.deletePolicyRule(r.name)
}
