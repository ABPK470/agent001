/**
 * Selector-based policy matching — pure functions, no state.
 *
 * Rules use the existing {@link PolicyRule} shape. A rule opts into the
 * selector evaluator by setting `condition === "selectors"` and providing
 * a `selectors` object inside `parameters`. This keeps storage and the
 * existing `action:<name>` matcher fully backward compatible while letting
 * hosted deployments express richer conditions:
 *
 *   {
 *     name: "hosted_block_workspace_reads",
 *     effect: PolicyEffect.Deny,
 *     condition: "selectors",
 *     parameters: {
 *       priority: 100,
 *       selectors: {
 *         role:     "hosted_user",
 *         tool:     "read_file",
 *         scope:    "app_workspace"
 *       },
 *       reason: "hosted users may not read the app workspace"
 *     }
 *   }
 *
 * Selectors:
 *   - role          : exact role match against {@link HostedPolicyContext.role}
 *   - runMode       : exact runMode match against {@link HostedPolicyContext.runMode}
 *   - tool          : exact tool name OR `prefix*` glob (e.g. "mssql_*")
 *   - path          : sandbox://** | workspace://** | absolute path glob
 *   - command       : RegExp source string matched against normalized command
 *   - network       : "none" — matches when the tool intends outbound traffic
 *   - scope         : "sandbox" | "attachment_store" | "app_workspace" | "system"
 *   - dbEnvironment : "dev" | "uat" | "prod"
 *   - dbOperation   : "query_read" | "sync_preview" | "sync_execute" | "ddl" | "dml"
 *
 * All present selectors must match (conjunction). A rule with an empty or
 * missing selectors object never matches — empty rules are inert by design.
 *
 * Resolution (see {@link resolveSelectorRules}):
 *   1. Filter to matching rules.
 *   2. Highest `parameters.priority` wins (default 0).
 *   3. On equal priority: deny > require_approval > allow.
 *   4. If no rule matches and runMode === "hosted", caller applies default-deny.
 */

import { isAbsolute, resolve, sep } from "node:path"
import {
  PolicyDbEnvironment,
  PolicyDbOperation,
  PolicyEffect,
  PolicyNetwork,
  PolicyRole,
  PolicyRunMode,
  PolicyScope
} from "../enums/index.js"
import type { PolicyRule, Step } from "../models/run-models.js"
import type { HostedPolicyContext } from "./policy-context.js"

// ── Selector schema ──────────────────────────────────────────────

export interface PolicySelectors {
  role?: PolicyRole
  runMode?: PolicyRunMode
  tool?: string
  path?: string
  command?: string // RegExp source
  network?: PolicyNetwork
  scope?: PolicyScope
  dbEnvironment?: PolicyDbEnvironment
  dbOperation?: PolicyDbOperation
}

export interface SelectorRuleParameters {
  priority?: number
  selectors?: PolicySelectors
  reason?: string
}

// ── Tool fact extraction ─────────────────────────────────────────

export interface ToolFacts {
  tool: string
  path?: string
  command?: string
  scope?: PolicyScope
  network?: PolicyNetwork
  dbEnvironment?: PolicyDbEnvironment
  dbOperation?: PolicyDbOperation
}

const MSSQL_DML_RE = /^\s*(insert|update|delete|merge|truncate)\b/i
const MSSQL_DDL_RE = /^\s*(create|alter|drop|grant|revoke)\b/i
const MSSQL_READ_RE = /^\s*(select|with|exec(?:ute)?\s+sp_help|sp_help)\b/i

/**
 * Project a {@link Step} into the canonical facts the selector matcher
 * understands. Tool-specific extraction lives here so the matcher itself
 * stays declarative.
 */
export function extractToolFacts(step: Step, ctx?: HostedPolicyContext): ToolFacts {
  const facts: ToolFacts = { tool: step.action }
  const input = step.input as Record<string, unknown>

  // File tools — path is the contained input.
  if (step.action === "read_file" || step.action === "write_file" || step.action === "list_directory") {
    const raw = typeof input["path"] === "string" ? (input["path"] as string) : undefined
    if (raw) {
      facts.path = raw
      facts.scope = classifyPath(raw, ctx?.sandboxRoot ?? null)
    }
  }

  // Shell tools — command is the contained input. Normalize before
  // matching so trivial whitespace differences don't sneak past
  // command-regex selectors. We do NOT strip leading `sudo`/`time`/`env`
  // here on purpose: the privileged-command rules want to MATCH those
  // verbs, not see through them.
  if (step.action === "run_command" || step.action === "shell") {
    const cmd = (input["command"] ?? input["cmd"] ?? "") as unknown
    if (typeof cmd === "string" && cmd.length > 0) {
      facts.command = cmd.replace(/\s+/g, " ").trim()
    }
  }

  // MSSQL tools — environment + operation classification.
  if (
    step.action.startsWith("mssql_") ||
    step.action === "query_mssql" ||
    step.action === "explore_mssql_schema" ||
    step.action === "export_query_to_file"
  ) {
    // Accept several aliases. `connection` is the existing tool param
    // name today (e.g. `query_mssql({ connection: "prod", ... })`); we
    // treat it as a synonym for `environment` when its value happens to
    // be one of the well-known environment keys, so per-env policy
    // selectors fire without requiring the model to learn a new arg.
    const candidates = [input["environment"], input["dbEnvironment"], input["env"], input["connection"]]
    let extracted: PolicyDbEnvironment | undefined
    for (const raw of candidates) {
      if (
        raw === PolicyDbEnvironment.Dev ||
        raw === PolicyDbEnvironment.Uat ||
        raw === PolicyDbEnvironment.Prod
      ) {
        extracted = raw
        break
      }
    }
    if (extracted) {
      facts.dbEnvironment = extracted
    } else if (ctx?.defaultDbEnvironment) {
      facts.dbEnvironment = ctx.defaultDbEnvironment
    }

    const sql =
      typeof input["sql"] === "string"
        ? (input["sql"] as string)
        : typeof input["query"] === "string"
          ? (input["query"] as string)
          : ""
    facts.dbOperation = classifyDbOperation(step.action, sql)
  }

  // Network-capable tools.
  if (step.action === "fetch_url") {
    facts.network = PolicyNetwork.Allow
  }

  return facts
}

function classifyPath(raw: string, sandboxRoot: string | null): PolicyScope {
  if (raw.startsWith("sandbox://")) return PolicyScope.Sandbox
  if (raw.startsWith("workspace://")) return PolicyScope.AppWorkspace
  if (raw.startsWith("attachment://")) return PolicyScope.AttachmentStore
  if (!sandboxRoot) return PolicyScope.System
  try {
    const abs = isAbsolute(raw) ? resolve(raw) : resolve(sandboxRoot, raw)
    const root = resolve(sandboxRoot)
    if (abs === root || abs.startsWith(root + sep)) return PolicyScope.Sandbox
    return PolicyScope.AppWorkspace
  } catch {
    return PolicyScope.System
  }
}

function classifyDbOperation(toolName: string, sql: string): PolicyDbOperation {
  if (toolName === "sync_preview" || toolName.endsWith("_sync_preview")) return PolicyDbOperation.SyncPreview
  if (toolName === "sync_diff_scan" || toolName === "resolve_sync_scope") return PolicyDbOperation.SyncPreview
  if (toolName === "sync_execute" || toolName.endsWith("_sync_execute")) return PolicyDbOperation.SyncExecute
  if (MSSQL_DDL_RE.test(sql)) return PolicyDbOperation.Ddl
  if (MSSQL_DML_RE.test(sql)) return PolicyDbOperation.Dml
  if (MSSQL_READ_RE.test(sql) || toolName === "explore_mssql_schema") return PolicyDbOperation.QueryRead
  // Conservative fallback: treat unknown SQL as DML so it cannot bypass
  // a UAT/PROD read-only policy by failing classification.
  return sql.length > 0 ? PolicyDbOperation.Dml : PolicyDbOperation.QueryRead
}

// ── Selector matching ────────────────────────────────────────────

/** Returns true when every defined selector on `rule` matches `facts` + `ctx`. */
export function matchesSelectorRule(
  rule: PolicyRule,
  facts: ToolFacts,
  ctx: HostedPolicyContext | undefined
): boolean {
  const params = rule.parameters as SelectorRuleParameters
  const sel = params?.selectors
  if (!sel || Object.keys(sel).length === 0) return false

  if (sel.role !== undefined && sel.role !== ctx?.role) return false
  if (sel.runMode !== undefined && sel.runMode !== ctx?.runMode) return false
  if (sel.tool !== undefined && !matchTool(sel.tool, facts.tool)) return false
  if (sel.scope !== undefined && sel.scope !== facts.scope) return false
  if (sel.network !== undefined && sel.network !== facts.network) return false
  if (sel.dbEnvironment !== undefined && sel.dbEnvironment !== facts.dbEnvironment) return false
  if (sel.dbOperation !== undefined && sel.dbOperation !== facts.dbOperation) return false
  if (sel.path !== undefined && !matchPath(sel.path, facts.path)) return false
  if (sel.command !== undefined && !matchCommand(sel.command, facts.command)) return false

  return true
}

function matchTool(pattern: string, tool: string): boolean {
  if (pattern === "*" || pattern === tool) return true
  if (pattern.endsWith("*")) return tool.startsWith(pattern.slice(0, -1))
  return false
}

function matchPath(pattern: string, value: string | undefined): boolean {
  if (!value) return false
  if (pattern === "*" || pattern === "**" || pattern === value) return true
  // Sandbox/workspace virtual prefixes: "sandbox://**" matches any path
  // already classified as that scope.
  if (pattern.endsWith("://**")) return value.startsWith(pattern.slice(0, -2))
  if (pattern.endsWith("/**")) return value.startsWith(pattern.slice(0, -3))
  if (pattern.endsWith("*")) return value.startsWith(pattern.slice(0, -1))
  return false
}

function matchCommand(patternSource: string, value: string | undefined): boolean {
  if (!value) return false
  try {
    // Accept "/expr/flags" or a bare expression body.
    const m = patternSource.match(/^\/(.+)\/([gimsuy]*)$/)
    const re = m ? new RegExp(m[1]!, m[2]) : new RegExp(patternSource, "i")
    return re.test(value)
  } catch {
    return false
  }
}

// ── Resolution ────────────────────────────────────────────────────

const EFFECT_RANK: Record<PolicyEffect, number> = {
  [PolicyEffect.Deny]: 3,
  [PolicyEffect.RequireApproval]: 2,
  [PolicyEffect.Allow]: 1
}

export interface SelectorResolution {
  rule: PolicyRule
  effect: PolicyEffect
}

/**
 * Pick the winning selector rule. Returns null when no selector rule matches.
 * Highest priority first; on tie, deny > require_approval > allow.
 */
export function resolveSelectorRules(
  rules: readonly PolicyRule[],
  facts: ToolFacts,
  ctx: HostedPolicyContext | undefined
): SelectorResolution | null {
  let best: { rule: PolicyRule; priority: number; rank: number } | null = null
  for (const rule of rules) {
    if (rule.condition !== "selectors") continue
    if (!matchesSelectorRule(rule, facts, ctx)) continue
    const priority = Number((rule.parameters as SelectorRuleParameters)?.priority ?? 0)
    const rank = EFFECT_RANK[rule.effect] ?? 0
    if (!best || priority > best.priority || (priority === best.priority && rank > best.rank)) {
      best = { rule, priority, rank }
    }
  }
  return best ? { rule: best.rule, effect: best.rule.effect } : null
}
