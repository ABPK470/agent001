/**
 * Sync HTTP tool approvals — policy RequireApproval grants for Env Sync
 * (no AgentRun). Matched by actor + tool + stable args like run grants.
 */

import { createHash, randomUUID } from "node:crypto"
import { stripRuntimeToolArgs } from "@mia/shared-types"
import { getDb } from "../connection.js"

export type SyncToolApprovalStatus = "pending" | "approved" | "denied" | "consumed"

export interface SyncToolApprovalRecord {
  id: string
  actorUpn: string
  toolName: string
  args: Record<string, unknown>
  argsKey: string
  reason: string
  policyName: string
  status: SyncToolApprovalStatus
  requestedAt: string
  resolvedAt: string | null
  resolvedBy: string | null
}

interface DbRow {
  id: string
  actor_upn: string
  tool_name: string
  args_json: string
  args_key: string
  reason: string
  policy_name: string
  status: SyncToolApprovalStatus
  requested_at: string
  resolved_at: string | null
  resolved_by: string | null
}

let ensured = false

export function ensureSyncToolApprovalsTable(): void {
  if (ensured) return
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS sync_tool_approvals (
      id            TEXT PRIMARY KEY,
      actor_upn     TEXT NOT NULL,
      tool_name     TEXT NOT NULL,
      args_json     TEXT NOT NULL,
      args_key      TEXT NOT NULL,
      reason        TEXT NOT NULL,
      policy_name   TEXT NOT NULL,
      status        TEXT NOT NULL CHECK (status IN ('pending','approved','denied','consumed')),
      requested_at  TEXT NOT NULL,
      resolved_at   TEXT,
      resolved_by   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sync_tool_approvals_actor
      ON sync_tool_approvals(actor_upn, tool_name, status);
    CREATE INDEX IF NOT EXISTS idx_sync_tool_approvals_pending
      ON sync_tool_approvals(status, requested_at DESC);
  `)
  ensured = true
}

function mapRow(row: DbRow): SyncToolApprovalRecord {
  return {
    id: row.id,
    actorUpn: row.actor_upn,
    toolName: row.tool_name,
    args: JSON.parse(row.args_json) as Record<string, unknown>,
    argsKey: row.args_key,
    reason: row.reason,
    policyName: row.policy_name,
    status: row.status,
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
  }
}

export function syncToolArgsKey(args: Record<string, unknown>): string {
  return JSON.stringify(stripRuntimeToolArgs(args))
}

export function syncToolFingerprint(toolName: string, args: Record<string, unknown>): string {
  const key = syncToolArgsKey(args)
  return createHash("sha256").update(`${toolName}\n${key}`).digest("hex").slice(0, 24)
}

export function upsertPendingSyncToolApproval(input: {
  actorUpn: string
  toolName: string
  args: Record<string, unknown>
  reason: string
  policyName: string
}): SyncToolApprovalRecord {
  ensureSyncToolApprovalsTable()
  const argsKey = syncToolArgsKey(input.args)
  const existing = getDb()
    .prepare(
      `SELECT * FROM sync_tool_approvals
       WHERE actor_upn = ? AND tool_name = ? AND args_key = ? AND status = 'pending'`,
    )
    .get(input.actorUpn, input.toolName, argsKey) as DbRow | undefined
  if (existing) return mapRow(existing)

  const row: DbRow = {
    id: randomUUID(),
    actor_upn: input.actorUpn,
    tool_name: input.toolName,
    args_json: JSON.stringify(input.args),
    args_key: argsKey,
    reason: input.reason,
    policy_name: input.policyName,
    status: "pending",
    requested_at: new Date().toISOString(),
    resolved_at: null,
    resolved_by: null,
  }
  getDb()
    .prepare(
      `INSERT INTO sync_tool_approvals
        (id, actor_upn, tool_name, args_json, args_key, reason, policy_name, status, requested_at, resolved_at, resolved_by)
       VALUES (@id, @actor_upn, @tool_name, @args_json, @args_key, @reason, @policy_name, @status, @requested_at, @resolved_at, @resolved_by)`,
    )
    .run(row)
  return mapRow(row)
}

export function getSyncToolApproval(id: string): SyncToolApprovalRecord | null {
  ensureSyncToolApprovalsTable()
  const row = getDb().prepare(`SELECT * FROM sync_tool_approvals WHERE id = ?`).get(id) as
    | DbRow
    | undefined
  return row ? mapRow(row) : null
}

export function listApprovedSyncToolGrants(
  actorUpn: string,
  toolName: string,
): Array<{ grantId: string; toolName: string; args: Record<string, unknown> }> {
  ensureSyncToolApprovalsTable()
  const rows = getDb()
    .prepare(
      `SELECT * FROM sync_tool_approvals
       WHERE actor_upn = ? AND tool_name = ? AND status = 'approved'
       ORDER BY resolved_at DESC`,
    )
    .all(actorUpn, toolName) as DbRow[]
  return rows.map((row) => ({
    grantId: row.id,
    toolName: row.tool_name,
    args: JSON.parse(row.args_json) as Record<string, unknown>,
  }))
}

export function markSyncToolApprovalApproved(
  id: string,
  actor: string,
): SyncToolApprovalRecord | null {
  ensureSyncToolApprovalsTable()
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `UPDATE sync_tool_approvals
       SET status = 'approved', resolved_at = ?, resolved_by = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(now, actor, id)
  return getSyncToolApproval(id)
}

export function markSyncToolApprovalDenied(
  id: string,
  actor: string,
): SyncToolApprovalRecord | null {
  ensureSyncToolApprovalsTable()
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `UPDATE sync_tool_approvals
       SET status = 'denied', resolved_at = ?, resolved_by = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(now, actor, id)
  return getSyncToolApproval(id)
}

export function consumeSyncToolApprovalGrant(id: string): void {
  ensureSyncToolApprovalsTable()
  getDb()
    .prepare(
      `UPDATE sync_tool_approvals SET status = 'consumed' WHERE id = ? AND status = 'approved'`,
    )
    .run(id)
}
