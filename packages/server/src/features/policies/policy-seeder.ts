/**
 * Policy seeding glue.
 *
 * Bridges the DB-persisted sync-environment registry with the in-memory
 * rule engine.
 *
 * Responsibilities:
 *   1. {@link seedDefaultPoliciesIfMissing} — on server boot, write the
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

import { type AgentHost } from "@mia/agent"
import { getEnvironments } from "@mia/sync"
import * as db from "../../platform/persistence/sqlite.js"
import { hostedDefaultPolicyRules, policyRulesFromEnvironments } from "./hosted-defaults.js"

// ── Policy rule seeding ──────────────────────────────────────────

/**
 * Insert hosted-default + per-env-derived rules into `policy_rules`
 * for any rule names that don't already exist. Returns counts.
 *
 * Call once at server startup AFTER the persisted env registry is loaded
 * so the derived rules reflect the live env config.
 */
export function seedDefaultPoliciesIfMissing(host: AgentHost): { hostedDefault: number; envDerived: number } {
  const now = new Date().toISOString()
  let hostedDefault = 0
  let envDerived = 0

  for (const r of hostedDefaultPolicyRules()) {
    const inserted = db.seedPolicyRuleIfMissing({
      name: r.name,
      effect: r.effect,
      condition: r.condition,
      parameters: JSON.stringify(r.parameters ?? {}),
      created_at: now,
      source: db.PolicySource.HostedDefault
    })
    if (inserted) hostedDefault++
  }

  for (const r of policyRulesFromEnvironments(getEnvironments(host))) {
    const inserted = db.seedPolicyRuleIfMissing({
      name: r.name,
      effect: r.effect,
      condition: r.condition,
      parameters: JSON.stringify(r.parameters ?? {}),
      created_at: now,
      source: db.PolicySource.EnvDerived
    })
    if (inserted) envDerived++
  }

  if (hostedDefault || envDerived) {
    console.log(
      `[policy-seeder] seeded ${hostedDefault} hosted_default + ${envDerived} env_derived policy rule(s)`
    )
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
  const existing = db
    .listPolicyRules()
    .filter((r) => r.source === db.PolicySource.EnvDerived && r.name.startsWith(prefix))
  for (const r of existing) db.deletePolicyRule(r.name)

  const env = getEnvironments(host).find((e) => e.name === envName)
  if (!env) return
  const now = new Date().toISOString()
  for (const r of policyRulesFromEnvironments([env])) {
    db.savePolicyRule({
      name: r.name,
      effect: r.effect,
      condition: r.condition,
      parameters: JSON.stringify(r.parameters ?? {}),
      created_at: now,
      source: db.PolicySource.EnvDerived
    })
  }
}
