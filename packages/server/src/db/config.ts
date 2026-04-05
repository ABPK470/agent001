/**
 * Layout & policy persistence.
 */

import { getDb } from "./connection.js"

// ── Layout queries ───────────────────────────────────────────────

export interface DbLayout {
  id: string
  name: string
  config: string
  updated_at: string
}

export function saveLayout(layout: DbLayout): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO layouts (id, name, config, updated_at)
    VALUES (@id, @name, @config, @updated_at)
  `).run(layout)
}

export function getLayouts(): DbLayout[] {
  return getDb()
    .prepare("SELECT * FROM layouts ORDER BY updated_at DESC")
    .all() as DbLayout[]
}

export function getLayout(id: string): DbLayout | undefined {
  return getDb()
    .prepare("SELECT * FROM layouts WHERE id = ?")
    .get(id) as DbLayout | undefined
}

export function deleteLayout(id: string): void {
  getDb().prepare("DELETE FROM layouts WHERE id = ?").run(id)
}

// ── Policy rule queries ──────────────────────────────────────────

export interface DbPolicyRule {
  name: string
  effect: string
  condition: string
  parameters: string
  created_at: string
}

export function listPolicyRules(): DbPolicyRule[] {
  return getDb()
    .prepare("SELECT * FROM policy_rules ORDER BY created_at")
    .all() as DbPolicyRule[]
}

export function savePolicyRule(rule: DbPolicyRule): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO policy_rules (name, effect, condition, parameters, created_at)
    VALUES (@name, @effect, @condition, @parameters, @created_at)
  `).run(rule)
}

export function deletePolicyRule(name: string): void {
  getDb().prepare("DELETE FROM policy_rules WHERE name = ?").run(name)
}
