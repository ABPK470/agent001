import { randomUUID } from "node:crypto"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runAllAsync, runExecAsync, runGetAsync } from "../../../schema/execute-async.js"
import { platformNow } from "../../../schema/sql-time.js"

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

export async function upsertPendingRunToolApproval(input: {
  runId: string
  stepId: string
  toolName: string
  args: Record<string, unknown>
  reason: string
  policyName: string
}): Promise<RunToolApprovalRecord> {
  const existingCompiled = getPlatformDb()
    .selectFrom("run_tool_approvals")
    .selectAll()
    .where("run_id", "=", input.runId)
    .where("step_id", "=", input.stepId)
    .where("status", "=", "pending")
    .compile()
  const existing = await runGetAsync<DbRunToolApproval>(existingCompiled)
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

  const compiled = getPlatformDb().insertInto("run_tool_approvals").values(row).compile()
  await runExecAsync(compiled)
  return mapRow(row)
}

export async function getRunToolApproval(id: string): Promise<RunToolApprovalRecord | null> {
  const compiled = getPlatformDb()
    .selectFrom("run_tool_approvals")
    .selectAll()
    .where("id", "=", id)
    .compile()
  const row = await runGetAsync<DbRunToolApproval>(compiled)
  return row ? mapRow(row) : null
}

export async function getPendingRunToolApproval(
  runId: string,
  stepId: string
): Promise<RunToolApprovalRecord | null> {
  const compiled = getPlatformDb()
    .selectFrom("run_tool_approvals")
    .selectAll()
    .where("run_id", "=", runId)
    .where("step_id", "=", stepId)
    .where("status", "=", "pending")
    .compile()
  const row = await runGetAsync<DbRunToolApproval>(compiled)
  return row ? mapRow(row) : null
}

export async function listPendingRunToolApprovalsForRuns(runIds: readonly string[]): Promise<RunToolApprovalRecord[]> {
  if (runIds.length === 0) return []
  const compiled = getPlatformDb()
    .selectFrom("run_tool_approvals")
    .selectAll()
    .where("run_id", "in", [...runIds])
    .where("status", "=", "pending")
    .orderBy("requested_at", "desc")
    .compile()
  return (await runAllAsync<DbRunToolApproval>(compiled)).map(mapRow)
}

export async function listApprovedToolGrantsForRuns(runIds: readonly string[]): Promise<RunToolApprovalRecord[]> {
  if (runIds.length === 0) return []
  const compiled = getPlatformDb()
    .selectFrom("run_tool_approvals")
    .selectAll()
    .where("run_id", "in", [...runIds])
    .where("status", "=", "approved")
    .orderBy("requested_at", "asc")
    .compile()
  return (await runAllAsync<DbRunToolApproval>(compiled)).map(mapRow)
}

export async function markRunToolApprovalApproved(id: string, actor: string): Promise<RunToolApprovalRecord | null> {
  const compiled = getPlatformDb()
    .updateTable("run_tool_approvals")
    .set({
      status: "approved",
      resolved_at: platformNow(),
      resolved_by: actor,
    })
    .where("id", "=", id)
    .where("status", "=", "pending")
    .compile()
  await runExecAsync(compiled)
  return getRunToolApproval(id)
}

export async function markRunToolApprovalDenied(
  id: string,
  actor: string
): Promise<RunToolApprovalRecord | null> {
  const compiled = getPlatformDb()
    .updateTable("run_tool_approvals")
    .set({
      status: "denied",
      resolved_at: platformNow(),
      resolved_by: actor,
    })
    .where("id", "=", id)
    .where("status", "=", "pending")
    .compile()
  await runExecAsync(compiled)
  return getRunToolApproval(id)
}

export async function consumeRunToolApprovalGrant(id: string): Promise<void> {
  const compiled = getPlatformDb()
    .updateTable("run_tool_approvals")
    .set({ status: "consumed" })
    .where("id", "=", id)
    .where("status", "=", "approved")
    .compile()
  await runExecAsync(compiled)
}

export async function markRunWaitingForApproval(runId: string): Promise<void> {
  const compiled = getPlatformDb()
    .updateTable("runs")
    .set({ status: "waiting_for_approval", error: null })
    .where("id", "=", runId)
    .compile()
  await runExecAsync(compiled)
}
