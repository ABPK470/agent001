/**
 * Policy seeding glue.
 *
 * Code defaults are a **first-boot seed only**. After insert, the DB (Policies
 * UI) is the source of truth — boot never refreshes, overwrites, or prunes
 * policy rows. Environments do not seed a second allow/deny dialect.
 */

import { type AgentHost } from "@mia/agent"
import * as db from "../../../infra/persistence/sqlite.js"
import { hostedDefaultPolicyRules } from "../types/hosted-defaults.js"

/**
 * Insert each code default only when that rule name is missing.
 * Existing rows (any source) are left untouched — including old
 * `hosted_default` rows an operator never edited.
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
      `[policy-seeder] seeded ${hostedDefault} missing default(s); cleared ${removed} env_derived leftover(s)`,
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
