/**
 * Selector schema — UI mirror of `packages/agent/src/engine/policy-selectors.ts`
 * and the policy-related enums in `packages/agent/src/engine/enums/policy.ts`.
 *
 * SINGLE SOURCE OF TRUTH for the Selector Rules editor:
 *  - which keys are valid inside `parameters.selectors`
 *  - what values each key accepts (enum members or free-form)
 *  - human-readable descriptions for every key + value
 *  - effect semantics, condition forms, priority bands, source labels
 *  - `summarizeRule()` → plain-English "what does this rule do?" string
 *
 * Keep this file in sync with the agent enums. The agent side enforces the
 * runtime contract; this file is what the UI displays to humans.
 */

import { AlertTriangle, ShieldCheck, ShieldX } from "lucide-react"
import type { ComponentType } from "react"
import type { PolicyRule } from "../../types"

// ──────────────────────────────────────────────────────────────────────────
// Effect
// ──────────────────────────────────────────────────────────────────────────

export type Effect = "allow" | "require_approval" | "deny"

export interface EffectMeta {
  value:       Effect
  label:       string
  description: string
  icon:        ComponentType<{ size?: number; className?: string }>
  color:       string  // tailwind text-* token
  bg:          string  // tailwind bg-*/* token
}

export const EFFECT_META: ReadonlyArray<EffectMeta> = Object.freeze([
  {
    value:       "allow",
    label:       "Allow",
    description: "Permit the action without prompting.",
    icon:        ShieldCheck,
    color:       "text-success",
    bg:          "bg-success/10",
  },
  {
    value:       "require_approval",
    label:       "Require approval",
    description: "Pause and ask the operator before running. Used for risky-but-legitimate actions.",
    icon:        AlertTriangle,
    color:       "text-warning",
    bg:          "bg-warning/10",
  },
  {
    value:       "deny",
    label:       "Deny",
    description: "Block the action outright. Agent receives a policy-denied error.",
    icon:        ShieldX,
    color:       "text-error",
    bg:          "bg-error/10",
  },
])

export function getEffectMeta(e: string): EffectMeta {
  return EFFECT_META.find((m) => m.value === e) ?? EFFECT_META[0]
}

// ──────────────────────────────────────────────────────────────────────────
// Selector keys
// ──────────────────────────────────────────────────────────────────────────

export interface EnumValue {
  value:       string
  description: string
}

export interface SelectorKeyMeta {
  key:         string                // JSON key inside parameters.selectors
  label:       string                // Human label shown in the form
  description: string                // What this selector matches
  /** "enum" → fixed dropdown; "tool" → free text + tool autocomplete; "string" → free text. */
  type:        "enum" | "tool" | "string"
  enumValues?: ReadonlyArray<EnumValue>
  /** Example values shown as inline hints / placeholders. */
  examples?:   ReadonlyArray<string>
  placeholder?: string
}

export const SELECTOR_KEYS: ReadonlyArray<SelectorKeyMeta> = Object.freeze([
  {
    key:         "role",
    label:       "Role",
    description: "Identity of the caller. Matches the role attached to the run.",
    type:        "enum",
    enumValues:  [
      { value: "admin",       description: "Operator / admin sessions. Full trust." },
      { value: "hosted_user", description: "External users running in a hosted sandbox." },
      { value: "visitor",     description: "Anonymous or unauthenticated callers." },
    ],
  },
  {
    key:         "runMode",
    label:       "Run mode",
    description: "Whether the run is operator-local (developer) or sandboxed (hosted).",
    type:        "enum",
    enumValues:  [
      { value: "developer", description: "Local mode. Agent acts in your real workspace (AGENT_HOSTED_MODE=off)." },
      { value: "hosted",    description: "Hosted mode. Each run gets an isolated sandbox; workspace path is ignored." },
    ],
  },
  {
    key:         "tool",
    label:       "Tool",
    description: "Tool name. Supports a single trailing wildcard, e.g. \"mssql_*\" matches every mssql_* tool.",
    type:        "tool",
    examples:    ["read_file", "run_command", "mssql_*", "sync_execute", "fetch_url"],
    placeholder: "tool name or prefix*",
  },
  {
    key:         "path",
    label:       "Path",
    description: "Glob over the file or virtual path the tool targets. Use the sandbox:// or workspace:// scheme.",
    type:        "string",
    examples:    ["sandbox://**", "workspace://**", "sandbox://reports/*.csv", "workspace://src/**"],
    placeholder: "sandbox://** or workspace://**",
  },
  {
    key:         "command",
    label:       "Command (regex)",
    description: "JavaScript RegExp source matched against the normalized command line. Accepts /pattern/flags or bare pattern.",
    type:        "string",
    examples:    ["/\\bsudo\\b/i", "^git\\s+push", "/rm\\s+-rf/i"],
    placeholder: "/\\bsudo\\b/i",
  },
  {
    key:         "network",
    label:       "Network",
    description: "Whether the action involves outbound network access.",
    type:        "enum",
    enumValues:  [
      { value: "none",  description: "No network access." },
      { value: "allow", description: "Outbound HTTP / network access is used." },
    ],
  },
  {
    key:         "scope",
    label:       "Scope",
    description: "Storage area the action targets.",
    type:        "enum",
    enumValues:  [
      { value: "sandbox",          description: "Per-run isolated sandbox area." },
      { value: "attachment_store", description: "Shared attachment storage." },
      { value: "app_workspace",    description: "The application/operator workspace (developer mode root)." },
      { value: "system",           description: "System-wide / outside the app's data dirs." },
    ],
  },
  {
    key:         "dbEnvironment",
    label:       "DB environment",
    description: "Target MSSQL environment as configured in deploy/sync/sync-environments.json.",
    type:        "enum",
    enumValues:  [
      { value: "dev",  description: "Development environment." },
      { value: "uat",  description: "User-acceptance / staging." },
      { value: "prod", description: "Production." },
    ],
  },
  {
    key:         "dbOperation",
    label:       "DB operation",
    description: "Kind of MSSQL operation about to run.",
    type:        "enum",
    enumValues:  [
      { value: "query_read",   description: "Read-only SELECT / introspection." },
      { value: "sync_preview", description: "Sync diff preview — no writes performed." },
      { value: "sync_execute", description: "Sync execution — writes rows on the target." },
      { value: "ddl",          description: "Schema-modifying DDL (CREATE / ALTER / DROP)." },
      { value: "dml",          description: "Data-modifying DML (INSERT / UPDATE / DELETE)." },
    ],
  },
])

export function getSelectorMeta(key: string): SelectorKeyMeta | undefined {
  return SELECTOR_KEYS.find((s) => s.key === key)
}

// ──────────────────────────────────────────────────────────────────────────
// Condition forms
// ──────────────────────────────────────────────────────────────────────────

export interface ConditionMeta {
  value:       string
  label:       string
  description: string
}

export const CONDITION_FORMS: ReadonlyArray<ConditionMeta> = Object.freeze([
  {
    value:       "selectors",
    label:       "selectors",
    description: "Standard form. Engine matches the selectors object against the request context.",
  },
  {
    value:       "action:<tool>",
    label:       "action:<tool>",
    description: "Coarse-grained shortcut. Matches a single tool by name regardless of arguments. Used by the Tool Permissions tab.",
  },
])

// ──────────────────────────────────────────────────────────────────────────
// Source / origin badges
// ──────────────────────────────────────────────────────────────────────────

import { PolicySource } from "@mia/shared-enums"
export { PolicySource }

export interface SourceMeta {
  value:       PolicySource
  label:       string
  badgeClass:  string
  description: string
}

export const SOURCE_META: Record<PolicySource, SourceMeta> = {
  [PolicySource.Db]: {
    value:       PolicySource.Db,
    label:       "operator",
    badgeClass:  "text-accent bg-accent/10",
    description: "Stored in the local database — created or edited by an operator in this UI.",
  },
  [PolicySource.HostedDefault]: {
    value:       PolicySource.HostedDefault,
    label:       "hosted default",
    badgeClass:  "text-text-muted bg-overlay-3",
    description: "Built-in baseline that ships with the app. Override by creating a higher-priority operator rule with the same selectors.",
  },
  [PolicySource.EnvDerived]: {
    value:       PolicySource.EnvDerived,
    label:       "env-derived",
    badgeClass:  "text-warning bg-warning/10",
    description: "Auto-generated from the per-environment config in the Environments tab. Edit there to change.",
  },
}

// ──────────────────────────────────────────────────────────────────────────
// Priority bands
// ──────────────────────────────────────────────────────────────────────────

export interface PriorityBand {
  min:         number
  max:         number
  label:       string
  description: string
  color:       string  // tailwind text-*
}

export const PRIORITY_BANDS: ReadonlyArray<PriorityBand> = Object.freeze([
  { min:   0, max:  10, label: "Baseline allow",    description: "Default permissive baselines.",                color: "text-text-muted" },
  { min:  11, max:  40, label: "Per-env allow",     description: "Per-environment allow extensions.",            color: "text-success" },
  { min:  41, max:  60, label: "Per-env approval",  description: "Per-environment approval requirements.",       color: "text-warning" },
  { min:  61, max:  85, label: "Deny",              description: "Hosted-default and per-env denies.",           color: "text-error" },
  { min:  86, max: 999, label: "Operator override", description: "Operator rules that beat all built-ins.",      color: "text-accent" },
])

export function getPriorityBand(p: number): PriorityBand {
  return PRIORITY_BANDS.find((b) => p >= b.min && p <= b.max) ?? PRIORITY_BANDS[0]
}

// ──────────────────────────────────────────────────────────────────────────
// Plain-English rule summary
// ──────────────────────────────────────────────────────────────────────────

interface ParsedRule {
  selectors: Record<string, string>
  priority:  number | null
  reason:    string | null
}

export function parseRuleParameters(rule: PolicyRule): ParsedRule {
  const p = (rule.parameters ?? {}) as Record<string, unknown>
  const selRaw = (p["selectors"] ?? {}) as Record<string, unknown>
  const selectors: Record<string, string> = {}
  for (const [k, v] of Object.entries(selRaw)) {
    if (typeof v === "string") selectors[k] = v
  }
  const priority = typeof p["priority"] === "number" ? (p["priority"] as number) : null
  const reason   = typeof p["reason"]   === "string" ? (p["reason"]   as string) : null
  return { selectors, priority, reason }
}

/**
 * Summarize a rule in one sentence:
 *   "Deny mssql_* with dbEnvironment=prod, dbOperation=dml when role=hosted_user."
 */
export function summarizeRule(rule: PolicyRule): string {
  const eff = getEffectMeta(rule.effect)
  const verb = eff.value === "allow" ? "Allow"
            : eff.value === "deny"  ? "Deny"
            : "Require approval for"

  // action:<tool> shortcut form
  if (rule.condition.startsWith("action:")) {
    const tool = rule.condition.slice("action:".length)
    return `${verb} every call to ${tool} (regardless of arguments).`
  }

  if (rule.condition !== "selectors") {
    return `${verb} requests matching custom condition "${rule.condition}".`
  }

  const { selectors } = parseRuleParameters(rule)
  const keys = Object.keys(selectors)
  if (keys.length === 0) return `${verb} every request (no selectors set).`

  // Order: tool first, then everything else
  const ordered = [
    ...(selectors["tool"] ? ["tool"] : []),
    ...keys.filter((k) => k !== "tool"),
  ]

  const parts = ordered.map((k) => `${k}=${selectors[k]}`)
  if (selectors["tool"]) {
    const rest = parts.slice(1)
    return rest.length === 0
      ? `${verb} ${selectors["tool"]}.`
      : `${verb} ${selectors["tool"]} when ${rest.join(", ")}.`
  }
  return `${verb} requests where ${parts.join(", ")}.`
}

// ──────────────────────────────────────────────────────────────────────────
// JSON ↔ form helpers
// ──────────────────────────────────────────────────────────────────────────

export interface RuleFormValue {
  name:      string
  effect:    Effect
  condition: string
  selectors: Record<string, string>
  priority:  number
  reason:    string
}

export const EMPTY_RULE_FORM: RuleFormValue = Object.freeze({
  name:      "",
  effect:    "allow",
  condition: "selectors",
  selectors: {},
  priority:  50,
  reason:    "",
}) as RuleFormValue

export function ruleToForm(r: PolicyRule): RuleFormValue {
  const { selectors, priority, reason } = parseRuleParameters(r)
  return {
    name:      r.name,
    effect:    (r.effect as Effect) ?? "allow",
    condition: r.condition || "selectors",
    selectors,
    priority:  priority ?? 50,
    reason:    reason ?? "",
  }
}

export function formToParameters(f: RuleFormValue): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  if (typeof f.priority === "number" && !Number.isNaN(f.priority)) params["priority"] = f.priority
  if (f.reason.trim()) params["reason"] = f.reason.trim()
  // Strip empty-string selectors
  const sel: Record<string, string> = {}
  for (const [k, v] of Object.entries(f.selectors)) {
    if (typeof v === "string" && v.trim() !== "") sel[k] = v
  }
  if (Object.keys(sel).length > 0) params["selectors"] = sel
  return params
}

// ──────────────────────────────────────────────────────────────────────────
// Common rule templates — one-click starters
// ──────────────────────────────────────────────────────────────────────────

export interface RuleTemplate {
  id:          string
  label:       string
  description: string
  form:        Omit<RuleFormValue, "name"> & { name: string }
}

export const RULE_TEMPLATES: ReadonlyArray<RuleTemplate> = Object.freeze([
  {
    id:          "deny_prod_dml",
    label:       "Deny DML on prod",
    description: "Block any INSERT/UPDATE/DELETE against the production MSSQL.",
    form: {
      name:      "deny_prod_dml",
      effect:    "deny",
      condition: "selectors",
      selectors: { tool: "mssql_*", dbEnvironment: "prod", dbOperation: "dml" },
      priority:  60,
      reason:    "PROD must not be written to via mssql_* tools.",
    },
  },
  {
    id:          "approve_prod_sync_execute",
    label:       "Require approval for prod sync_execute",
    description: "Pause and ask before any sync_execute targets prod.",
    form: {
      name:      "approve_prod_sync_execute",
      effect:    "require_approval",
      condition: "selectors",
      selectors: { tool: "sync_execute", dbEnvironment: "prod" },
      priority:  50,
      reason:    "Sync into prod requires explicit operator confirmation.",
    },
  },
  {
    id:          "deny_prod_ddl",
    label:       "Deny DDL on prod",
    description: "Block schema changes (CREATE/ALTER/DROP) on prod.",
    form: {
      name:      "deny_prod_ddl",
      effect:    "deny",
      condition: "selectors",
      selectors: { tool: "mssql_*", dbEnvironment: "prod", dbOperation: "ddl" },
      priority:  60,
      reason:    "Schema changes on prod must go via change control, not the agent.",
    },
  },
  {
    id:          "approve_outbound_fetch",
    label:       "Require approval for outbound HTTP",
    description: "Pause before any fetch_url with network access.",
    form: {
      name:      "approve_outbound_fetch",
      effect:    "require_approval",
      condition: "selectors",
      selectors: { tool: "fetch_url", network: "allow" },
      priority:  20,
      reason:    "Outbound HTTP must be approved by an operator.",
    },
  },
  {
    id:          "deny_workspace_access_hosted",
    label:       "Deny workspace access in hosted mode",
    description: "Hosted users cannot read or write the operator workspace.",
    form: {
      name:      "deny_hosted_workspace",
      effect:    "deny",
      condition: "selectors",
      selectors: { role: "hosted_user", scope: "app_workspace" },
      priority:  70,
      reason:    "Hosted runs are sandbox-only; the operator workspace is off-limits.",
    },
  },
  {
    id:          "deny_destructive_shell",
    label:       "Deny destructive shell commands",
    description: "Block sudo / rm -rf / git push and similar in hosted mode.",
    form: {
      name:      "deny_destructive_shell",
      effect:    "deny",
      condition: "selectors",
      selectors: { role: "hosted_user", tool: "run_command", command: "/\\b(sudo|rm\\s+-rf|git\\s+push)\\b/i" },
      priority:  60,
      reason:    "Privileged or destructive commands are blocked in hosted mode.",
    },
  },
  {
    id:          "allow_ddl_on_dev",
    label:       "Allow DDL on dev",
    description: "Let the agent freely run schema changes against dev.",
    form: {
      name:      "allow_dev_ddl",
      effect:    "allow",
      condition: "selectors",
      selectors: { tool: "mssql_*", dbEnvironment: "dev", dbOperation: "ddl" },
      priority:  35,
      reason:    "DEV is a scratch environment; DDL is allowed.",
    },
  },
  {
    id:          "require_approval_attachment_promote",
    label:       "Require approval to promote attachments",
    description: "Pause before an attachment is promoted into the shared store.",
    form: {
      name:      "approve_attachment_promote",
      effect:    "require_approval",
      condition: "selectors",
      selectors: { tool: "promote_attachment", scope: "attachment_store" },
      priority:  40,
      reason:    "Promoting an attachment is irreversible; ask first.",
    },
  },
])
