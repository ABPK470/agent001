/**
 * Browser domain policy — allow/deny list with glob host matching.
 *
 * Evaluation order:
 *   1. If a `deny` rule (tenant or global) matches the host → DENY.
 *   2. Else if any `allow` rules exist for the tenant or global, and
 *      none of them match the host → DENY (default-deny becomes active
 *      the moment an allow-list exists).
 *   3. Else → ALLOW.
 *
 * Pattern syntax:
 *   - `example.com`      exact host match
 *   - `*.example.com`    matches example.com and any subdomain
 *   - `**`              matches everything (use sparingly)
 *
 * `owner_upn = NULL` rows are global (admin-installed); per-user rows
 * stack on top.
 *
 * @module
 */

import { randomUUID } from "node:crypto"

import { getDb } from "../adapters/persistence/sqlite.js"

export interface PolicyRule {
  id: string
  ownerUpn: string | null
  pattern: string
  effect: "allow" | "deny"
  reason: string
  createdAt: string
}

interface Row {
  id: string
  owner_upn: string | null
  pattern: string
  effect: "allow" | "deny"
  reason: string
  created_at: string
}

function toRule(r: Row): PolicyRule {
  return {
    id: r.id,
    ownerUpn: r.owner_upn,
    pattern: r.pattern,
    effect: r.effect,
    reason: r.reason,
    createdAt: r.created_at,
  }
}

export function addPolicyRule(input: {
  ownerUpn: string | null
  pattern: string
  effect: "allow" | "deny"
  reason?: string
}): PolicyRule {
  const id = randomUUID()
  getDb().prepare(
    `INSERT INTO browser_domain_policy (id, owner_upn, pattern, effect, reason)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, input.ownerUpn, input.pattern.toLowerCase(), input.effect, input.reason ?? "")
  const row = getDb().prepare("SELECT * FROM browser_domain_policy WHERE id = ?").get(id) as Row
  return toRule(row)
}

export function deletePolicyRule(id: string): boolean {
  const res = getDb().prepare("DELETE FROM browser_domain_policy WHERE id = ?").run(id)
  return res.changes > 0
}

export function listPolicyRules(ownerUpn: string | null): PolicyRule[] {
  // Returns tenant + global. Pass null for "list global only".
  const rows = ownerUpn
    ? getDb().prepare(
        "SELECT * FROM browser_domain_policy WHERE owner_upn = ? OR owner_upn IS NULL ORDER BY effect, pattern",
      ).all(ownerUpn) as Row[]
    : getDb().prepare(
        "SELECT * FROM browser_domain_policy WHERE owner_upn IS NULL ORDER BY effect, pattern",
      ).all() as Row[]
  return rows.map(toRule)
}

/**
 * Glob match: `**` = always; `*.suffix` = host equals suffix or ends
 * with `.suffix`; otherwise exact equality (case-insensitive). No
 * regex parsing — keeps the surface tight and predictable.
 */
export function matchPattern(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase()
  const h = host.toLowerCase()
  if (p === "**") return true
  if (p.startsWith("*.")) {
    const suffix = p.slice(2)
    return h === suffix || h.endsWith(`.${suffix}`)
  }
  return h === p
}

export interface PolicyDecision {
  allow: boolean
  /** Human-readable reason. Empty string when allow=true and no allow-list exists. */
  reason: string
  /** The matching rule id, when one was decisive. */
  ruleId: string | null
}

export function evaluatePolicy(ownerUpn: string, url: string): PolicyDecision {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return { allow: false, reason: `invalid URL: ${url}`, ruleId: null }
  }
  if (!host) return { allow: false, reason: "URL has no hostname", ruleId: null }

  const rules = listPolicyRules(ownerUpn)

  // 1) Deny rules win.
  for (const r of rules) {
    if (r.effect === "deny" && matchPattern(r.pattern, host)) {
      return {
        allow: false,
        reason: r.reason ? `denied by policy: ${r.reason}` : `denied by policy rule ${r.pattern}`,
        ruleId: r.id,
      }
    }
  }

  // 2) If any allow-list rules exist, become default-deny.
  const allowRules = rules.filter((r) => r.effect === "allow")
  if (allowRules.length > 0) {
    for (const r of allowRules) {
      if (matchPattern(r.pattern, host)) return { allow: true, reason: "", ruleId: r.id }
    }
    return {
      allow: false,
      reason: `host ${host} is not on the tenant allow-list`,
      ruleId: null,
    }
  }

  // 3) Default allow.
  return { allow: true, reason: "", ruleId: null }
}
