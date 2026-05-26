/**
 * Browser audit log — append-only record of agent-driven browser
 * activity. Pruned by the existing `pruneOldData` housekeeping job.
 *
 * @module
 */

import { getDb } from "../adapters/persistence/sqlite.js"

export interface AuditEntry {
  id: number
  ownerUpn: string
  action: string
  targetUrl: string | null
  detail: string | null
  decision: "allow" | "deny" | "captcha" | "error"
  createdAt: string
}

export function appendAudit(input: {
  ownerUpn: string
  action: string
  targetUrl?: string | null
  detail?: string | null
  decision?: AuditEntry["decision"]
}): void {
  getDb().prepare(
    `INSERT INTO browser_audit_log (owner_upn, action, target_url, detail, decision)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    input.ownerUpn,
    input.action,
    input.targetUrl ?? null,
    input.detail ?? null,
    input.decision ?? "allow",
  )
}

export function listAuditLog(input: {
  ownerUpn: string
  limit?: number
}): AuditEntry[] {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000)
  const rows = getDb().prepare(
    `SELECT id, owner_upn, action, target_url, detail, decision, created_at
       FROM browser_audit_log
      WHERE owner_upn = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
  ).all(input.ownerUpn, limit) as Array<{
    id: number
    owner_upn: string
    action: string
    target_url: string | null
    detail: string | null
    decision: AuditEntry["decision"]
    created_at: string
  }>
  return rows.map((r) => ({
    id: r.id,
    ownerUpn: r.owner_upn,
    action: r.action,
    targetUrl: r.target_url,
    detail: r.detail,
    decision: r.decision,
    createdAt: r.created_at,
  }))
}
