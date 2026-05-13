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

import { PolicyEffect, type PolicyRule } from "@agent001/agent"

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
