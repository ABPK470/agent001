/**
 * Hosted-profile default policy rules.
 *
 * Seeded into the per-run policy evaluator only when the run executes under
 * the hosted profile. Loaded after the DB-stored rules so operator-defined
 * rules can override defaults via priority. Not persisted to the DB; these
 * defaults belong to the running deployment, not to operator configuration.
 *
 * The rule shape matches {@link PolicyRule}: `condition: "selectors"` with
 * the selector object on `parameters.selectors`. See the selector engine in
 * `packages/agent/src/engine/policy-selectors.ts` for matching semantics.
 *
 * Defaults are intentionally minimal:
 *   - File I/O is allowed inside the sandbox, denied in the app workspace.
 *   - Shell is allowed inside the sandbox but blocks privileged commands.
 *   - MSSQL reads + schema introspection are allowed everywhere.
 *   - MSSQL DML/DDL are denied on UAT and PROD; DEV is left to operator
 *     policy so the deployment can opt in explicitly.
 *   - Outbound network tools require explicit approval.
 */

import { PolicyEffect, type PolicyRule } from "@mia/agent"

const DEFAULT_PRIORITY = 10
const PRIVILEGED_COMMAND_RE = String.raw`/\b(sudo|ssh|scp|git\s+push|winget|powershell\s+Set-|icacls|reg\s+add|net\s+user|chmod\s+\+s)\b/i`

export function hostedDefaultPolicyRules(): PolicyRule[] {
  return [
    // ── Filesystem ──────────────────────────────────────────────
    {
      name:       "hosted_allow_sandbox_reads",
      effect:     PolicyEffect.Allow,
      condition:  "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY,
        reason:   "sandbox reads are allowed for hosted runs",
        selectors: { role: "hosted_user", tool: "read_file", scope: "sandbox" },
      },
    },
    {
      name:       "hosted_allow_sandbox_writes",
      effect:     PolicyEffect.Allow,
      condition:  "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY,
        reason:   "sandbox writes are allowed for hosted runs",
        selectors: { role: "hosted_user", tool: "write_file", scope: "sandbox" },
      },
    },
    {
      name:       "hosted_allow_sandbox_listing",
      effect:     PolicyEffect.Allow,
      condition:  "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY,
        reason:   "sandbox listing is allowed for hosted runs",
        selectors: { role: "hosted_user", tool: "list_directory", scope: "sandbox" },
      },
    },
    {
      name:       "hosted_deny_workspace_file_access",
      effect:     PolicyEffect.Deny,
      condition:  "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY + 50,
        reason:   "hosted users may not access the application workspace",
        selectors: { role: "hosted_user", tool: "read_file", scope: "app_workspace" },
      },
    },
    {
      name:       "hosted_deny_workspace_writes",
      effect:     PolicyEffect.Deny,
      condition:  "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY + 50,
        reason:   "hosted users may not write to the application workspace",
        selectors: { role: "hosted_user", tool: "write_file", scope: "app_workspace" },
      },
    },

    // ── Shell ───────────────────────────────────────────────────
    {
      name:       "hosted_allow_sandbox_shell",
      effect:     PolicyEffect.Allow,
      condition:  "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY,
        reason:   "shell commands are allowed inside the sandbox for hosted runs",
        selectors: { role: "hosted_user", tool: "run_command" },
      },
    },
    {
      name:       "hosted_deny_privileged_commands",
      effect:     PolicyEffect.Deny,
      condition:  "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY + 50,
        reason:   "privileged or destructive shell commands are blocked in hosted mode",
        selectors: { role: "hosted_user", tool: "run_command", command: PRIVILEGED_COMMAND_RE },
      },
    },

    // ── MSSQL ───────────────────────────────────────────────────
    {
      name:       "hosted_allow_mssql_reads",
      effect:     PolicyEffect.Allow,
      condition:  "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY,
        reason:   "MSSQL reads are allowed across environments",
        selectors: { role: "hosted_user", tool: "mssql_*", dbOperation: "query_read" },
      },
    },
    {
      name:       "hosted_allow_query_mssql_reads",
      effect:     PolicyEffect.Allow,
      condition:  "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY,
        reason:   "query_mssql reads are allowed across environments",
        selectors: { role: "hosted_user", tool: "query_mssql", dbOperation: "query_read" },
      },
    },
    {
      name:       "hosted_allow_schema_introspection",
      effect:     PolicyEffect.Allow,
      condition:  "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY,
        reason:   "schema introspection is allowed across environments",
        selectors: { role: "hosted_user", tool: "explore_mssql_schema" },
      },
    },
    {
      name:       "hosted_deny_uat_dml",
      effect:     PolicyEffect.Deny,
      condition:  "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY + 50,
        reason:   "UAT is read-only by default in hosted mode",
        selectors: { role: "hosted_user", tool: "mssql_*", dbEnvironment: "uat", dbOperation: "dml" },
      },
    },
    {
      name:       "hosted_deny_uat_ddl",
      effect:     PolicyEffect.Deny,
      condition:  "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY + 50,
        reason:   "UAT DDL is denied by default in hosted mode",
        selectors: { role: "hosted_user", tool: "mssql_*", dbEnvironment: "uat", dbOperation: "ddl" },
      },
    },
    {
      name:       "hosted_deny_prod_dml",
      effect:     PolicyEffect.Deny,
      condition:  "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY + 50,
        reason:   "PROD is read-only by default in hosted mode",
        selectors: { role: "hosted_user", tool: "mssql_*", dbEnvironment: "prod", dbOperation: "dml" },
      },
    },
    {
      name:       "hosted_deny_prod_ddl",
      effect:     PolicyEffect.Deny,
      condition:  "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY + 50,
        reason:   "PROD DDL is denied by default in hosted mode",
        selectors: { role: "hosted_user", tool: "mssql_*", dbEnvironment: "prod", dbOperation: "ddl" },
      },
    },

    // ── Sync / network ──────────────────────────────────────────
    {
      name:       "hosted_allow_sync_preview",
      effect:     PolicyEffect.Allow,
      condition:  "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY,
        reason:   "sync previews are read-only and allowed by default",
        selectors: { role: "hosted_user", tool: "sync_preview" },
      },
    },
    {
      name:       "hosted_require_approval_sync_execute",
      effect:     PolicyEffect.RequireApproval,
      condition:  "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY + 25,
        reason:   "sync_execute requires explicit user confirmation in hosted mode",
        selectors: { role: "hosted_user", tool: "sync_execute" },
      },
    },
    {
      name:       "hosted_require_approval_outbound_fetch",
      effect:     PolicyEffect.RequireApproval,
      condition:  "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY,
        reason:   "outbound HTTP fetches require explicit approval in hosted mode",
        selectors: { role: "hosted_user", tool: "fetch_url", network: "allow" },
      },
    },

    // ── Generic safety net ──────────────────────────────────────
    {
      name:       "hosted_allow_think",
      effect:     PolicyEffect.Allow,
      condition:  "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY,
        selectors: { role: "hosted_user", tool: "think" },
      },
    },
    {
      name:       "hosted_allow_ask_user",
      effect:     PolicyEffect.Allow,
      condition:  "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY,
        selectors: { role: "hosted_user", tool: "ask_user" },
      },
    },
    {
      name:       "hosted_allow_list_environments",
      effect:     PolicyEffect.Allow,
      condition:  "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY,
        selectors: { role: "hosted_user", tool: "list_environments" },
      },
    },
    {
      name:       "hosted_allow_search_catalog",
      effect:     PolicyEffect.Allow,
      condition:  "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY,
        selectors: { role: "hosted_user", tool: "search_catalog" },
      },
    },
  ]
}

// ── Per-environment derived rules ──────────────────────────────────

/**
 * Derive selector rules from the per-environment permission config so
 * operators can widen or tighten the per-environment defaults from
 * `deploy/mssql/sync-environments.json` without forking this file.
 *
 * For each environment we emit:
 *   - one DENY rule per `denyDml` / `denyDdl` flag (priority above defaults
 *     so a deployment that opts in to read-only beats the loose `mssql_*`
 *     allow rules already in {@link hostedDefaultPolicyRules}),
 *   - one REQUIRE_APPROVAL rule per entry in `approvalRequiredOperations`,
 *   - one ALLOW rule per non-trivial entry in `allowedOperations` (so a
 *     DEV opt-in for `dml` actually fires under the conjunctive matcher).
 *
 * Rules are evaluated in tie-breaking priority order: deny > approval >
 * allow at equal priority. We give per-env DENY rules a higher base
 * priority than the `hostedDefaultPolicyRules()` defaults so a
 * deployment that explicitly says "PROD allows DML" can still be
 * overridden by a per-deployment `denyDml: true` flag.
 */
const PER_ENV_DENY_PRIORITY     = DEFAULT_PRIORITY + 75
const PER_ENV_APPROVAL_PRIORITY = DEFAULT_PRIORITY + 50
const PER_ENV_ALLOW_PRIORITY    = DEFAULT_PRIORITY + 25

interface EnvLike {
  name: string
  denyDml: boolean
  denyDdl: boolean
  allowedOperations: ReadonlyArray<string>
  approvalRequiredOperations: ReadonlyArray<string>
}

export function policyRulesFromEnvironments(envs: ReadonlyArray<EnvLike>): PolicyRule[] {
  const rules: PolicyRule[] = []
  for (const e of envs) {
    const envKey = e.name as "dev" | "uat" | "prod"
    if (envKey !== "dev" && envKey !== "uat" && envKey !== "prod") {
      // The selector engine only knows three environment keys today.
      // Custom env names are still policed by the catch-all default-deny
      // when running under hosted profile.
      continue
    }

    if (e.denyDml) {
      rules.push({
        name:       `env_${envKey}_deny_dml`,
        effect:     PolicyEffect.Deny,
        condition:  "selectors",
        parameters: {
          priority: PER_ENV_DENY_PRIORITY,
          reason:   `${envKey}.denyDml: hosted env config blocks DML`,
          selectors: { tool: "mssql_*", dbEnvironment: envKey, dbOperation: "dml" },
        },
      })
      rules.push({
        name:       `env_${envKey}_deny_dml_query_mssql`,
        effect:     PolicyEffect.Deny,
        condition:  "selectors",
        parameters: {
          priority: PER_ENV_DENY_PRIORITY,
          reason:   `${envKey}.denyDml: hosted env config blocks DML`,
          selectors: { tool: "query_mssql", dbEnvironment: envKey, dbOperation: "dml" },
        },
      })
    }
    if (e.denyDdl) {
      rules.push({
        name:       `env_${envKey}_deny_ddl`,
        effect:     PolicyEffect.Deny,
        condition:  "selectors",
        parameters: {
          priority: PER_ENV_DENY_PRIORITY,
          reason:   `${envKey}.denyDdl: hosted env config blocks DDL`,
          selectors: { tool: "mssql_*", dbEnvironment: envKey, dbOperation: "ddl" },
        },
      })
      rules.push({
        name:       `env_${envKey}_deny_ddl_query_mssql`,
        effect:     PolicyEffect.Deny,
        condition:  "selectors",
        parameters: {
          priority: PER_ENV_DENY_PRIORITY,
          reason:   `${envKey}.denyDdl: hosted env config blocks DDL`,
          selectors: { tool: "query_mssql", dbEnvironment: envKey, dbOperation: "ddl" },
        },
      })
    }

    for (const op of e.approvalRequiredOperations) {
      if (!isPolicyDbOperation(op)) continue
      rules.push({
        name:       `env_${envKey}_approval_${op}`,
        effect:     PolicyEffect.RequireApproval,
        condition:  "selectors",
        parameters: {
          priority: PER_ENV_APPROVAL_PRIORITY,
          reason:   `${envKey}.approvalRequiredOperations: ${op} requires confirmation`,
          selectors: { tool: "mssql_*", dbEnvironment: envKey, dbOperation: op },
        },
      })
    }

    // Explicit per-env allow for DEV widenings (e.g. `allowedOperations: ["dml"]`).
    // We do NOT emit allow rules for `query_read` / `schema_introspect` /
    // `sync_preview` — those are already covered by the cross-env defaults
    // in {@link hostedDefaultPolicyRules}.
    for (const op of e.allowedOperations) {
      if (op !== "dml" && op !== "ddl" && op !== "sync_execute") continue
      // Don't emit an allow that contradicts an explicit deny on the same env.
      if (op === "dml" && e.denyDml) continue
      if (op === "ddl" && e.denyDdl) continue
      rules.push({
        name:       `env_${envKey}_allow_${op}`,
        effect:     PolicyEffect.Allow,
        condition:  "selectors",
        parameters: {
          priority: PER_ENV_ALLOW_PRIORITY,
          reason:   `${envKey}.allowedOperations: ${op} explicitly permitted`,
          selectors: { tool: "mssql_*", dbEnvironment: envKey, dbOperation: op },
        },
      })
    }
  }
  return rules
}

function isPolicyDbOperation(op: string): op is "query_read" | "sync_preview" | "sync_execute" | "ddl" | "dml" {
  return op === "query_read" || op === "sync_preview" || op === "sync_execute" || op === "ddl" || op === "dml"
}
