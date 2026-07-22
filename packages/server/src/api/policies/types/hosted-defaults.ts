/**
 * Default product policy rules (seeded into `policy_configs` as hosted_default).
 *
 * Apply to **everyone** under the single governance rail (default-deny): agent
 * tools and HTTP Sync share {@link buildPolicyContext}. Selectors are not
 * locked to `hosted_user` — admin does not bypass Policies.
 *
 * Workspace isolation (`AGENT_HOSTED_MODE`) is separate from this file.
 *
 * Defaults are intentionally minimal:
 *   - File I/O is allowed inside the sandbox, denied in the app workspace.
 *   - Shell is allowed inside the sandbox but blocks privileged commands.
 *   - MSSQL reads + schema introspection are allowed everywhere.
 *   - MSSQL DML/DDL are denied on UAT and PROD; DEV is left to operator
 *     policy so the deployment can opt in explicitly.
 *   - Sync preview allowed; sync_execute requires approval.
 *   - Outbound network tools require explicit approval.
 *
 * Disclosure-policy linkage (Phase E.4): the `hosted_deny_workspace_*`
 * rules below are the HARD rail for the soft prose in the prompt's
 * `<information_disclosure>` section.
 */

import { DisclosureCategory } from "./disclosure-categories.js"

import {
  isPolicyDbOperation,
  PolicyDbEnvironment,
  PolicyDbOperation,
  PolicyEffect,
  PolicyNetwork,
  type PolicyRule
} from "@mia/agent"

const DEFAULT_PRIORITY = 10
const PRIVILEGED_COMMAND_RE = String.raw`/\b(sudo|ssh|scp|git\s+push|winget|powershell\s+Set-|icacls|reg\s+add|net\s+user|chmod\s+\+s)\b/i`

export function hostedDefaultPolicyRules(): PolicyRule[] {
  return [
    // ── Filesystem ──────────────────────────────────────────────
    {
      name: "hosted_allow_sandbox_reads",
      effect: PolicyEffect.Allow,
      condition: "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY,
        reason: "sandbox reads are allowed for hosted runs",
        selectors: {
          tool: "read_file",
          scope: "sandbox"
        }
      }
    },
    {
      name: "hosted_allow_sandbox_writes",
      effect: PolicyEffect.Allow,
      condition: "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY,
        reason: "sandbox writes are allowed for hosted runs",
        selectors: {
          tool: "write_file",
          scope: "sandbox"
        }
      }
    },
    {
      name: "hosted_allow_sandbox_listing",
      effect: PolicyEffect.Allow,
      condition: "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY,
        reason: "sandbox listing is allowed for hosted runs",
        selectors: {
          tool: "list_directory",
          scope: "sandbox"
        }
      }
    },
    {
      name: "hosted_deny_workspace_file_access",
      effect: PolicyEffect.Deny,
      condition: "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY + 50,
        reason: `hosted users may not access the application workspace (disclosure: ${DisclosureCategory.Internals})`,
        selectors: {
          tool: "read_file",
          scope: "app_workspace"
        }
      }
    },
    {
      name: "hosted_deny_workspace_writes",
      effect: PolicyEffect.Deny,
      condition: "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY + 50,
        reason: `hosted users may not write to the application workspace (disclosure: ${DisclosureCategory.Internals})`,
        selectors: {
          tool: "write_file",
          scope: "app_workspace"
        }
      }
    },
    {
      name: "hosted_deny_workspace_listing",
      effect: PolicyEffect.Deny,
      condition: "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY + 50,
        reason: `hosted users may not list the application workspace (disclosure: ${DisclosureCategory.Internals})`,
        selectors: {
          tool: "list_directory",
          scope: "app_workspace"
        }
      }
    },

    // ── Shell ───────────────────────────────────────────────────
    {
      name: "hosted_allow_sandbox_shell",
      effect: PolicyEffect.Allow,
      condition: "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY,
        reason: "shell commands are allowed inside the sandbox for hosted runs",
        selectors: {
          tool: "run_command"
        }
      }
    },
    {
      name: "hosted_deny_privileged_commands",
      effect: PolicyEffect.Deny,
      condition: "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY + 50,
        reason: "privileged or destructive shell commands are blocked in hosted mode",
        selectors: {
          tool: "run_command",
          command: PRIVILEGED_COMMAND_RE
        }
      }
    },

    // ── MSSQL ───────────────────────────────────────────────────
    {
      name: "hosted_allow_mssql_reads",
      effect: PolicyEffect.Allow,
      condition: "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY,
        reason: "MSSQL reads are allowed across environments",
        selectors: {
          tool: "mssql_*",
          dbOperation: PolicyDbOperation.QueryRead
        }
      }
    },
    {
      name: "hosted_allow_query_mssql_reads",
      effect: PolicyEffect.Allow,
      condition: "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY,
        reason: "query_mssql reads are allowed across environments",
        selectors: {
          tool: "query_mssql",
          dbOperation: PolicyDbOperation.QueryRead
        }
      }
    },
    {
      name: "hosted_allow_schema_introspection",
      effect: PolicyEffect.Allow,
      condition: "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY,
        reason: "schema introspection is allowed across environments",
        selectors: {
          tool: "explore_mssql_schema"
        }
      }
    },
    {
      name: "hosted_deny_uat_dml",
      effect: PolicyEffect.Deny,
      condition: "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY + 50,
        reason: "UAT is read-only by default in hosted mode",
        selectors: {
          tool: "mssql_*",
          dbEnvironment: PolicyDbEnvironment.Uat,
          dbOperation: PolicyDbOperation.Dml
        }
      }
    },
    {
      name: "hosted_deny_uat_ddl",
      effect: PolicyEffect.Deny,
      condition: "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY + 50,
        reason: "UAT DDL is denied by default in hosted mode",
        selectors: {
          tool: "mssql_*",
          dbEnvironment: PolicyDbEnvironment.Uat,
          dbOperation: PolicyDbOperation.Ddl
        }
      }
    },
    {
      name: "hosted_deny_prod_dml",
      effect: PolicyEffect.Deny,
      condition: "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY + 50,
        reason: "PROD is read-only by default in hosted mode",
        selectors: {
          tool: "mssql_*",
          dbEnvironment: PolicyDbEnvironment.Prod,
          dbOperation: PolicyDbOperation.Dml
        }
      }
    },
    {
      name: "hosted_deny_prod_ddl",
      effect: PolicyEffect.Deny,
      condition: "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY + 50,
        reason: "PROD DDL is denied by default in hosted mode",
        selectors: {
          tool: "mssql_*",
          dbEnvironment: PolicyDbEnvironment.Prod,
          dbOperation: PolicyDbOperation.Ddl
        }
      }
    },

    // ── Sync / network ──────────────────────────────────────────
    {
      name: "hosted_allow_sync_preview",
      effect: PolicyEffect.Allow,
      condition: "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY,
        reason: "sync previews are read-only and allowed by default",
        selectors: {
          tool: "sync_preview"
        }
      }
    },
    {
      name: "hosted_require_approval_sync_execute",
      effect: PolicyEffect.RequireApproval,
      condition: "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY + 25,
        reason: "sync_execute requires explicit user confirmation in hosted mode",
        selectors: {
          tool: "sync_execute"
        }
      }
    },
    {
      name: "hosted_deny_sync_shell_execute",
      effect: PolicyEffect.Deny,
      condition: "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY + 75,
        reason:
          "shell commands during sync are denied in hosted mode unless a higher-priority allow rule is added",
        selectors: {
          dbOperation: PolicyDbOperation.SyncShellExecute
        }
      }
    },
    {
      name: "hosted_deny_sync_custom_sql_prod_uat",
      effect: PolicyEffect.Deny,
      condition: "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY + 60,
        reason: "ad-hoc SQL during sync is denied on UAT/PROD unless explicitly allowed",
        selectors: {
          dbOperation: PolicyDbOperation.SyncCustomSql,
          dbEnvironment: PolicyDbEnvironment.Uat
        }
      }
    },
    {
      name: "hosted_deny_sync_custom_sql_prod",
      effect: PolicyEffect.Deny,
      condition: "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY + 60,
        reason: "ad-hoc SQL during sync is denied on UAT/PROD unless explicitly allowed",
        selectors: {
          dbOperation: PolicyDbOperation.SyncCustomSql,
          dbEnvironment: PolicyDbEnvironment.Prod
        }
      }
    },
    {
      name: "hosted_require_approval_outbound_fetch",
      effect: PolicyEffect.RequireApproval,
      condition: "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY,
        reason: "outbound HTTP fetches require explicit approval in hosted mode",
        selectors: {
          tool: "fetch_url",
          network: PolicyNetwork.Allow
        }
      }
    },

    // ── Generic safety net ──────────────────────────────────────
    {
      name: "hosted_allow_think",
      effect: PolicyEffect.Allow,
      condition: "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY,
        selectors: {
          tool: "think"
        }
      }
    },
    {
      name: "hosted_allow_ask_user",
      effect: PolicyEffect.Allow,
      condition: "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY,
        selectors: {
          tool: "ask_user"
        }
      }
    },
    {
      name: "hosted_allow_list_environments",
      effect: PolicyEffect.Allow,
      condition: "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY,
        selectors: {
          tool: "list_environments"
        }
      }
    },
    {
      name: "hosted_allow_list_sync_definitions",
      effect: PolicyEffect.Allow,
      condition: "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY,
        selectors: {
          tool: "list_sync_definitions"
        }
      }
    },
    {
      name: "hosted_allow_resolve_sync_scope",
      effect: PolicyEffect.Allow,
      condition: "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY,
        selectors: {
          tool: "resolve_sync_scope"
        }
      }
    },
    {
      name: "hosted_allow_sync_diff_scan",
      effect: PolicyEffect.Allow,
      condition: "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY,
        selectors: {
          tool: "sync_diff_scan"
        }
      }
    },
    {
      name: "hosted_allow_search_catalog",
      effect: PolicyEffect.Allow,
      condition: "selectors",
      parameters: {
        priority: DEFAULT_PRIORITY,
        selectors: {
          tool: "search_catalog"
        }
      }
    }
  ]
}

// ── Per-environment derived rules ──────────────────────────────────

/**
 * Derive selector rules from the per-environment permission config so
 * operators can widen or tighten the per-environment defaults from
 * `deploy/sync/sync-environments.json` without forking this file.
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
const PER_ENV_DENY_PRIORITY = DEFAULT_PRIORITY + 75
const PER_ENV_APPROVAL_PRIORITY = DEFAULT_PRIORITY + 50
const PER_ENV_ALLOW_PRIORITY = DEFAULT_PRIORITY + 25

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
    const envKey = e.name as PolicyDbEnvironment
    if (
      envKey !== PolicyDbEnvironment.Dev &&
      envKey !== PolicyDbEnvironment.Uat &&
      envKey !== PolicyDbEnvironment.Prod
    ) {
      // The selector engine only knows three environment keys today.
      // Custom env names are still policed by the catch-all default-deny
      // when running under hosted profile.
      continue
    }

    if (e.denyDml) {
      rules.push({
        name: `env_${envKey}_deny_dml`,
        effect: PolicyEffect.Deny,
        condition: "selectors",
        parameters: {
          priority: PER_ENV_DENY_PRIORITY,
          reason: `${envKey}.denyDml: hosted env config blocks DML`,
          selectors: { tool: "mssql_*", dbEnvironment: envKey, dbOperation: PolicyDbOperation.Dml }
        }
      })
      rules.push({
        name: `env_${envKey}_deny_dml_query_mssql`,
        effect: PolicyEffect.Deny,
        condition: "selectors",
        parameters: {
          priority: PER_ENV_DENY_PRIORITY,
          reason: `${envKey}.denyDml: hosted env config blocks DML`,
          selectors: {
            tool: "query_mssql",
            dbEnvironment: envKey,
            dbOperation: PolicyDbOperation.Dml
          }
        }
      })
    }
    if (e.denyDdl) {
      rules.push({
        name: `env_${envKey}_deny_ddl`,
        effect: PolicyEffect.Deny,
        condition: "selectors",
        parameters: {
          priority: PER_ENV_DENY_PRIORITY,
          reason: `${envKey}.denyDdl: hosted env config blocks DDL`,
          selectors: { tool: "mssql_*", dbEnvironment: envKey, dbOperation: PolicyDbOperation.Ddl }
        }
      })
      rules.push({
        name: `env_${envKey}_deny_ddl_query_mssql`,
        effect: PolicyEffect.Deny,
        condition: "selectors",
        parameters: {
          priority: PER_ENV_DENY_PRIORITY,
          reason: `${envKey}.denyDdl: hosted env config blocks DDL`,
          selectors: {
            tool: "query_mssql",
            dbEnvironment: envKey,
            dbOperation: PolicyDbOperation.Ddl
          }
        }
      })
    }
    for (const op of e.approvalRequiredOperations) {
      if (!isPolicyDbOperation(op)) continue
      const tool = syncToolForDbOperation(op)
      rules.push({
        name: `env_${envKey}_approval_${op}`,
        effect: PolicyEffect.RequireApproval,
        condition: "selectors",
        parameters: {
          priority: PER_ENV_APPROVAL_PRIORITY,
          reason: `${envKey}.approvalRequiredOperations: ${op} requires confirmation`,
          selectors: tool
            ? { tool, dbEnvironment: envKey, dbOperation: op }
            : { tool: "mssql_*", dbEnvironment: envKey, dbOperation: op }
        }
      })
    }
    // Explicit per-env allow for DEV widenings (e.g. `allowedOperations: ["dml"]`).
    // We do NOT emit allow rules for `query_read` / `schema_introspect` /
    // `sync_preview` — those are already covered by the cross-env defaults
    // in {@link hostedDefaultPolicyRules}.
    for (const op of e.allowedOperations) {
      if (
        op !== PolicyDbOperation.Dml &&
        op !== PolicyDbOperation.Ddl &&
        op !== PolicyDbOperation.SyncExecute &&
        op !== PolicyDbOperation.SyncCustomSql &&
        op !== PolicyDbOperation.SyncShellExecute
      )
        continue
      // Don't emit an allow that contradicts an explicit deny on the same env.
      if (op === PolicyDbOperation.Dml && e.denyDml) continue
      if (op === PolicyDbOperation.Ddl && e.denyDdl) continue
      const syncTool = syncToolForDbOperation(op)
      rules.push({
        name: `env_${envKey}_allow_${op}`,
        effect: PolicyEffect.Allow,
        condition: "selectors",
        parameters: {
          priority: PER_ENV_ALLOW_PRIORITY,
          reason: `${envKey}.allowedOperations: ${op} explicitly permitted`,
          selectors: syncTool
            ? { tool: syncTool, dbEnvironment: envKey, dbOperation: op }
            : { tool: "mssql_*", dbEnvironment: envKey, dbOperation: op }
        }
      })
    }
  }
  return rules
}

/** Sync ops must match sync tools — not mssql_* — or HTTP/agent Sync never hits the rule. */
function syncToolForDbOperation(op: string): string | null {
  if (op === PolicyDbOperation.SyncExecute) return "sync_execute"
  if (op === PolicyDbOperation.SyncPreview) return "sync_preview"
  if (op === PolicyDbOperation.SyncCustomSql) return "sync_custom_sql"
  if (op === PolicyDbOperation.SyncShellExecute) return "sync_shell_execute"
  return null
}
