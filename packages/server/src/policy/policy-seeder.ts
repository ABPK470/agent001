/**
 * Policy & environment seeding/merging glue.
 *
 * Bridges the DB-persisted operator config with the in-memory rule
 * engine and the JSON-bootstrapped sync-environment registry.
 *
 * Two responsibilities:
 *   1. {@link applyEnvOverrides} — after `setupEnvironments()` loads the
 *      JSON config, merge any per-env operator overrides from
 *      `sync_environment_overrides` on top, re-applying
 *      `withPermissionDefaults()` so missing fields stay sensible.
 *   2. {@link seedDefaultPoliciesIfMissing} — on server boot, write the
 *      hosted-default and per-env-derived rule sets into `policy_rules`
 *      with provenance (`source = 'hosted_default' | 'env_derived'`) so
 *      the admin UI can list them, and the operator can edit/delete them
 *      via the existing `/api/policies` endpoints. Rules are seeded only
 *      when no row of the same name exists, so operator edits survive
 *      restart and operator deletes are persistent.
 *
 * Env-derived rules are tagged with the env name so they can be
 * refreshed cleanly when an admin edits the env config:
 * {@link refreshEnvDerivedPolicies} drops every `env_derived` rule for
 * the named env and re-inserts the freshly-derived ones.
 */

import {
    type AgentHost,
} from "@mia/agent"
import {
    getEnvironments,
    replaceEnvironments,
    withPermissionDefaults,
    type SyncEnvironment,
} from "@mia/sync"
import * as db from "../db/index.js"
import { hostedDefaultPolicyRules, policyRulesFromEnvironments } from "./hosted-defaults.js"

// ── Environment overrides (DB on top of JSON) ────────────────────

/**
 * Read every row from `sync_environment_overrides`, merge each on top of
 * the matching loaded environment, and replace the registry.
 *
 * Safe to call multiple times — it always re-reads the current registry
 * via `getEnvironments()` so calling it after a hot edit picks up the
 * latest JSON-loaded baseline.
 */
export function applyEnvOverrides(host: AgentHost): void {
  const overrides = new Map<string, Partial<SyncEnvironment>>()
  for (const row of db.listSyncEnvOverrides()) {
    try {
      overrides.set(row.name, JSON.parse(row.overrides_json) as Partial<SyncEnvironment>)
    } catch (e) {
      console.warn(`[policy-seeder] invalid override JSON for env "${row.name}":`, e instanceof Error ? e.message : e)
    }
  }
  if (overrides.size === 0) return
  const merged = getEnvironments(host).map((e) => {
    const o = overrides.get(e.name)
    return o ? withPermissionDefaults({ ...e, ...o, name: e.name }) : e
  })
  replaceEnvironments(host, merged)
  console.log(`[policy-seeder] applied ${overrides.size} sync-env override(s): ${Array.from(overrides.keys()).join(", ")}`)
}

// ── Policy rule seeding ──────────────────────────────────────────

/**
 * Insert hosted-default + per-env-derived rules into `policy_rules`
 * for any rule names that don't already exist. Returns counts.
 *
 * Call once at server startup AFTER `applyEnvOverrides()` so the derived
 * rules reflect the merged env config.
 */
export function seedDefaultPoliciesIfMissing(host: AgentHost): { hostedDefault: number; envDerived: number } {
  const now = new Date().toISOString()
  let hostedDefault = 0
  let envDerived = 0

  for (const r of hostedDefaultPolicyRules()) {
    const inserted = db.seedPolicyRuleIfMissing({
      name:       r.name,
      effect:     r.effect,
      condition:  r.condition,
      parameters: JSON.stringify(r.parameters ?? {}),
      created_at: now,
      source:     db.PolicySource.HostedDefault,
    })
    if (inserted) hostedDefault++
  }

  for (const r of policyRulesFromEnvironments(getEnvironments(host))) {
    const inserted = db.seedPolicyRuleIfMissing({
      name:       r.name,
      effect:     r.effect,
      condition:  r.condition,
      parameters: JSON.stringify(r.parameters ?? {}),
      created_at: now,
      source:     db.PolicySource.EnvDerived,
    })
    if (inserted) envDerived++
  }

  if (hostedDefault || envDerived) {
    console.log(`[policy-seeder] seeded ${hostedDefault} hosted_default + ${envDerived} env_derived policy rule(s)`)
  }
  return { hostedDefault, envDerived }
}

/**
 * After an admin edits env config, drop every `env_derived` rule whose
 * `name` starts with `env_<name>_` and re-insert the freshly-derived set.
 * Operator-edited rules ({@link db.PolicySource} = `'db'`) are never
 * touched — even if their name collides with a derived one.
 */
export function refreshEnvDerivedPolicies(host: AgentHost, envName: string): void {
  const prefix = `env_${envName}_`
  const existing = db.listPolicyRules().filter((r) => r.source === db.PolicySource.EnvDerived && r.name.startsWith(prefix))
  for (const r of existing) db.deletePolicyRule(r.name)

  const env = getEnvironments(host).find((e) => e.name === envName)
  if (!env) return
  const now = new Date().toISOString()
  for (const r of policyRulesFromEnvironments([env])) {
    db.savePolicyRule({
      name:       r.name,
      effect:     r.effect,
      condition:  r.condition,
      parameters: JSON.stringify(r.parameters ?? {}),
      created_at: now,
      source:     db.PolicySource.EnvDerived,
    })
  }
}
