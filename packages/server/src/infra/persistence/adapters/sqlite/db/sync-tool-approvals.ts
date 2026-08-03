/**
 * Sync HTTP tool approvals — policy RequireApproval grants for Env Sync
 * (no AgentRun). Matched by actor + tool + stable args like run grants.
 */

import { createHash, randomUUID } from "node:crypto"
import { stripRuntimeToolArgs } from "@mia/shared-types"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runAllAsync, runExecAsync, runGetAsync } from "../../../schema/execute-async.js"

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

/** Table is owned by SQLite baseline (+ mssql/postgres registry peers). */
export function ensureSyncToolApprovalsTable(): void {
  // no-op — kept for call-site stability
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

export async function upsertPendingSyncToolApproval(input: {
  actorUpn: string
  toolName: string
  args: Record<string, unknown>
  reason: string
  policyName: string
}): Promise<SyncToolApprovalRecord> {
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
  const existing = await runGetAsync<DbRow>(existingCompiled)
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
  await runExecAsync(compiled)
  return mapRow(row)
}

export async function getSyncToolApproval(id: string): Promise<SyncToolApprovalRecord | null> {
  ensureSyncToolApprovalsTable()
  const compiled = getPlatformDb()
    .selectFrom("sync_tool_approvals")
    .selectAll()
    .where("id", "=", id)
    .compile()
  const row = await runGetAsync<DbRow>(compiled)
  return row ? mapRow(row) : null
}

export async function listApprovedSyncToolGrants(
  actorUpn: string,
  toolName: string,
): Promise<Array<{ grantId: string; toolName: string; args: Record<string, unknown> }>> {
  ensureSyncToolApprovalsTable()
  const compiled = getPlatformDb()
    .selectFrom("sync_tool_approvals")
    .selectAll()
    .where("actor_upn", "=", actorUpn)
    .where("tool_name", "=", toolName)
    .where("status", "=", "approved")
    .orderBy("resolved_at", "desc")
    .compile()
  return (await runAllAsync<DbRow>(compiled)).map((row) => ({
    grantId: row.id,
    toolName: row.tool_name,
    args: JSON.parse(row.args_json) as Record<string, unknown>,
  }))
}

export async function markSyncToolApprovalApproved(
  id: string,
  actor: string,
): Promise<SyncToolApprovalRecord | null> {
  ensureSyncToolApprovalsTable()
  const now = new Date().toISOString()
  const compiled = getPlatformDb()
    .updateTable("sync_tool_approvals")
    .set({ status: "approved", resolved_at: now, resolved_by: actor })
    .where("id", "=", id)
    .where("status", "=", "pending")
    .compile()
  await runExecAsync(compiled)
  return getSyncToolApproval(id)
}

export async function markSyncToolApprovalDenied(
  id: string,
  actor: string,
): Promise<SyncToolApprovalRecord | null> {
  ensureSyncToolApprovalsTable()
  const now = new Date().toISOString()
  const compiled = getPlatformDb()
    .updateTable("sync_tool_approvals")
    .set({ status: "denied", resolved_at: now, resolved_by: actor })
    .where("id", "=", id)
    .where("status", "=", "pending")
    .compile()
  await runExecAsync(compiled)
  return getSyncToolApproval(id)
}

export async function consumeSyncToolApprovalGrant(id: string): Promise<void> {
  ensureSyncToolApprovalsTable()
  const compiled = getPlatformDb()
    .updateTable("sync_tool_approvals")
    .set({ status: "consumed" })
    .where("id", "=", id)
    .where("status", "=", "approved")
    .compile()
  await runExecAsync(compiled)
}
