import { randomUUID } from "node:crypto"

import { getDb } from "../connection.js"

export type RunToolApprovalStatus = "pending" | "approved" | "denied" | "consumed"

export interface DbRunToolApproval {
  id: string
  run_id: string
  step_id: string
  tool_name: string
  args_json: string
  reason: string
  policy_name: string
  status: RunToolApprovalStatus
  requested_at: string
  resolved_at: string | null
  resolved_by: string | null
}

export interface RunToolApprovalRecord {
  id: string
  runId: string
  stepId: string
  toolName: string
  args: Record<string, unknown>
  reason: string
  policyName: string
  status: RunToolApprovalStatus
  requestedAt: string
  resolvedAt: string | null
  resolvedBy: string | null
}

function mapRow(row: DbRunToolApproval): RunToolApprovalRecord {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    toolName: row.tool_name,
    args: JSON.parse(row.args_json) as Record<string, unknown>,
    reason: row.reason,
    policyName: row.policy_name,
    status: row.status,
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
  }
}

export function upsertPendingRunToolApproval(input: {
  runId: string
  stepId: string
  toolName: string
  args: Record<string, unknown>
  reason: string
  policyName: string
}): RunToolApprovalRecord {
  const existing = getDb()
    .prepare(
      `SELECT * FROM run_tool_approvals WHERE run_id = ? AND step_id = ? AND status = 'pending'`
    )
    .get(input.runId, input.stepId) as DbRunToolApproval | undefined

  if (existing) return mapRow(existing)

  const row: DbRunToolApproval = {
    id: randomUUID(),
    run_id: input.runId,
    step_id: input.stepId,
    tool_name: input.toolName,
    args_json: JSON.stringify(input.args),
    reason: input.reason,
    policy_name: input.policyName,
    status: "pending",
    requested_at: new Date().toISOString(),
    resolved_at: null,
    resolved_by: null,
  }

  getDb()
    .prepare(
      `INSERT INTO run_tool_approvals
        (id, run_id, step_id, tool_name, args_json, reason, policy_name, status, requested_at, resolved_at, resolved_by)
       VALUES (@id, @run_id, @step_id, @tool_name, @args_json, @reason, @policy_name, @status, @requested_at, @resolved_at, @resolved_by)`
    )
    .run(row)

  return mapRow(row)
}

export function getRunToolApproval(id: string): RunToolApprovalRecord | null {
  const row = getDb()
    .prepare(`SELECT * FROM run_tool_approvals WHERE id = ?`)
    .get(id) as DbRunToolApproval | undefined
  return row ? mapRow(row) : null
}

export function getPendingRunToolApproval(
  runId: string,
  stepId: string
): RunToolApprovalRecord | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM run_tool_approvals WHERE run_id = ? AND step_id = ? AND status = 'pending'`
    )
    .get(runId, stepId) as DbRunToolApproval | undefined
  return row ? mapRow(row) : null
}

export function listPendingRunToolApprovalsForRuns(runIds: readonly string[]): RunToolApprovalRecord[] {
  if (runIds.length === 0) return []
  const placeholders = runIds.map(() => "?").join(", ")
  const rows = getDb()
    .prepare(
      `SELECT * FROM run_tool_approvals
       WHERE run_id IN (${placeholders}) AND status = 'pending'
       ORDER BY requested_at DESC`
    )
    .all(...runIds) as DbRunToolApproval[]
  return rows.map(mapRow)
}

export function listApprovedToolGrantsForRuns(runIds: readonly string[]): RunToolApprovalRecord[] {
  if (runIds.length === 0) return []
  const placeholders = runIds.map(() => "?").join(", ")
  const rows = getDb()
    .prepare(
      `SELECT * FROM run_tool_approvals
       WHERE run_id IN (${placeholders}) AND status = 'approved'
       ORDER BY requested_at ASC`
    )
    .all(...runIds) as DbRunToolApproval[]
  return rows.map(mapRow)
}

export function markRunToolApprovalApproved(id: string, actor: string): RunToolApprovalRecord | null {
  getDb()
    .prepare(
      `UPDATE run_tool_approvals
       SET status = 'approved', resolved_at = datetime('now'), resolved_by = ?
       WHERE id = ? AND status = 'pending'`
    )
    .run(actor, id)
  return getRunToolApproval(id)
}

export function markRunToolApprovalDenied(
  id: string,
  actor: string
): RunToolApprovalRecord | null {
  getDb()
    .prepare(
      `UPDATE run_tool_approvals
       SET status = 'denied', resolved_at = datetime('now'), resolved_by = ?
       WHERE id = ? AND status = 'pending'`
    )
    .run(actor, id)
  return getRunToolApproval(id)
}

export function consumeRunToolApprovalGrant(id: string): void {
  getDb()
    .prepare(`UPDATE run_tool_approvals SET status = 'consumed' WHERE id = ? AND status = 'approved'`)
    .run(id)
}

export function markRunWaitingForApproval(runId: string): void {
  getDb()
    .prepare(
      `UPDATE runs SET status = 'waiting_for_approval', error = NULL WHERE id = ?`
    )
    .run(runId)
}
