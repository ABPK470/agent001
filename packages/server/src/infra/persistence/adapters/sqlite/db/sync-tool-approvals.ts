/**
 * Sync HTTP tool approvals — policy RequireApproval grants for Env Sync
 * (no AgentRun). Matched by actor + tool + stable args like run grants.
 */

import { createHash, randomUUID } from "node:crypto"
import { stripRuntimeToolArgs } from "@mia/shared-types"
import { getDb } from "../connection.js"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runAll, runExec, runGet } from "../../../schema/execute.js"

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
  // DDL bootstrap until this table is guaranteed by numbered migrations on all installs.
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
  const existingCompiled = getPlatformDb()
    .selectFrom("sync_tool_approvals")
    .selectAll()
    .where("actor_upn", "=", input.actorUpn)
    .where("tool_name", "=", input.toolName)
    .where("args_key", "=", argsKey)
    .where("status", "=", "pending")
    .compile()
  const existing = runGet<DbRow>(existingCompiled)
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
  const compiled = getPlatformDb().insertInto("sync_tool_approvals").values(row).compile()
  runExec(compiled)
  return mapRow(row)
}

export function getSyncToolApproval(id: string): SyncToolApprovalRecord | null {
  ensureSyncToolApprovalsTable()
  const compiled = getPlatformDb()
    .selectFrom("sync_tool_approvals")
    .selectAll()
    .where("id", "=", id)
    .compile()
  const row = runGet<DbRow>(compiled)
  return row ? mapRow(row) : null
}

export function listApprovedSyncToolGrants(
  actorUpn: string,
  toolName: string,
): Array<{ grantId: string; toolName: string; args: Record<string, unknown> }> {
  ensureSyncToolApprovalsTable()
  const compiled = getPlatformDb()
    .selectFrom("sync_tool_approvals")
    .selectAll()
    .where("actor_upn", "=", actorUpn)
    .where("tool_name", "=", toolName)
    .where("status", "=", "approved")
    .orderBy("resolved_at", "desc")
    .compile()
  return runAll<DbRow>(compiled).map((row) => ({
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
  const compiled = getPlatformDb()
    .updateTable("sync_tool_approvals")
    .set({ status: "approved", resolved_at: now, resolved_by: actor })
    .where("id", "=", id)
    .where("status", "=", "pending")
    .compile()
  runExec(compiled)
  return getSyncToolApproval(id)
}

export function markSyncToolApprovalDenied(
  id: string,
  actor: string,
): SyncToolApprovalRecord | null {
  ensureSyncToolApprovalsTable()
  const now = new Date().toISOString()
  const compiled = getPlatformDb()
    .updateTable("sync_tool_approvals")
    .set({ status: "denied", resolved_at: now, resolved_by: actor })
    .where("id", "=", id)
    .where("status", "=", "pending")
    .compile()
  runExec(compiled)
  return getSyncToolApproval(id)
}

export function consumeSyncToolApprovalGrant(id: string): void {
  ensureSyncToolApprovalsTable()
  const compiled = getPlatformDb()
    .updateTable("sync_tool_approvals")
    .set({ status: "consumed" })
    .where("id", "=", id)
    .where("status", "=", "approved")
    .compile()
  runExec(compiled)
}
