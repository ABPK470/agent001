/**
 * Policy seeding glue.
 *
 * Seeds / refreshes code-defined defaults into `policy_configs`. Operator
 * edits (`source = db`) are never overwritten. Environments do not seed
 * a second allow/deny dialect.
 */

import { type AgentHost } from "@mia/agent"
import * as db from "../../../infra/persistence/sqlite.js"
import { hostedDefaultPolicyRules } from "../types/hosted-defaults.js"

/**
 * Insert missing hosted defaults and refresh any row still tagged
 * `hosted_default` from code (so selector cleanups land without wiping
 * operator `db` edits). Clears leftover env_derived Access seeds.
 */
export function seedDefaultPoliciesIfMissing(_host: AgentHost): {
  hostedDefault: number
  refreshed: number
  envDerived: number
} {
  const now = new Date().toISOString()
  let hostedDefault = 0
  let refreshed = 0
  const existingByName = new Map(db.listPolicyRules().map((r) => [r.name, r]))

  for (const r of hostedDefaultPolicyRules()) {
    const parameters = JSON.stringify(r.parameters ?? {})
    const existing = existingByName.get(r.name)
    if (!existing) {
      const inserted = db.seedPolicyRuleIfMissing({
        name: r.name,
        effect: r.effect,
        condition: r.condition,
        parameters,
        created_at: now,
        source: db.PolicySource.HostedDefault,
      })
      if (inserted) hostedDefault++
      continue
    }
    if (existing.source !== db.PolicySource.HostedDefault) continue
    if (
      existing.effect === r.effect
      && existing.condition === r.condition
      && existing.parameters === parameters
    ) {
      continue
    }
    db.savePolicyRule({
      name: r.name,
      effect: r.effect,
      condition: r.condition,
      parameters,
      created_at: existing.created_at,
      source: db.PolicySource.HostedDefault,
      updated_at: now,
      updated_by: null,
    })
    refreshed++
  }

  const removed = clearAllEnvDerivedPolicies()
  if (hostedDefault || refreshed || removed) {
    console.log(
      `[policy-seeder] seeded ${hostedDefault} + refreshed ${refreshed} hosted_default; cleared ${removed} env_derived leftover(s)`,
    )
  }
  return { hostedDefault, refreshed, envDerived: 0 }
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
export function refreshEnvDerivedPolicies(_host: AgentHost, envName: string): void {
  const prefix = `env_${envName}_`
  const existing = db
    .listPolicyRules()
    .filter((r) => r.source === db.PolicySource.EnvDerived && r.name.startsWith(prefix))
  for (const r of existing) db.deletePolicyRule(r.name)
}
