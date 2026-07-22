/**
 * Policy seeding glue.
 *
 * Bridges hosted-default rules into `policy_configs`. Environments are Sync
 * topology only — they no longer seed a second allow/deny/approve dialect.
 * Leftover `env_derived` rows are cleared on boot / env save.
 */

import { type AgentHost } from "@mia/agent"
import * as db from "../../../infra/persistence/sqlite.js"
import { hostedDefaultPolicyRules } from "../types/hosted-defaults.js"

// ── Policy rule seeding ──────────────────────────────────────────

/**
 * Insert hosted-default rules into `policy_configs` for any rule names that
 * don't already exist. Clears leftover env_derived Access seeds.
 * Returns counts.
 */
export function seedDefaultPoliciesIfMissing(_host: AgentHost): {
  hostedDefault: number
  envDerived: number
} {
  const now = new Date().toISOString()
  let hostedDefault = 0

  for (const r of hostedDefaultPolicyRules()) {
    const inserted = db.seedPolicyRuleIfMissing({
      name: r.name,
      effect: r.effect,
      condition: r.condition,
      parameters: JSON.stringify(r.parameters ?? {}),
      created_at: now,
      source: db.PolicySource.HostedDefault,
    })
    if (inserted) hostedDefault++
  }

  const removed = clearAllEnvDerivedPolicies()
  if (hostedDefault || removed) {
    console.log(
      `[policy-seeder] seeded ${hostedDefault} hosted_default rule(s); cleared ${removed} env_derived leftover(s)`,
    )
  }
  return { hostedDefault, envDerived: 0 }
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
