import { EventType } from "@mia/agent"
import { stripRuntimeToolArgs } from "@mia/shared-types"

import { canAccessRun, requireSessionUpn } from "../../api/auth/service/access.js"
import type { ViewingAs } from "../../api/auth/service/viewing-as.js"
import { broadcast } from "../../infra/events/broadcaster.js"
import * as db from "../../infra/persistence/sqlite.js"
import type { AgentOrchestrator } from "../orchestrator.js"

function stableArgsKey(args: Record<string, unknown>): string {
  return JSON.stringify(stripRuntimeToolArgs(args))
}

async function assertCanActOnApproval(
  viewingAs: ViewingAs,
  approval: db.RunToolApprovalRecord
): Promise<void> {
  const run = await db.getRun(approval.runId)
  if (!run || !canAccessRun(viewingAs, run)) {
    throw new Error("Run not found")
  }
  if (approval.status !== "pending") {
    throw new Error(`Approval is already ${approval.status}`)
  }
}

export async function approveRunToolStep(
  orchestrator: AgentOrchestrator,
  approvalId: string,
  viewingAs: ViewingAs,
): Promise<{ ok: true; runId: string; resumedRunId: string | null }> {
  const actor = requireSessionUpn(viewingAs.session)
  const approval =
    await db.getRunToolApproval(approvalId) ??
    (() => {
      throw new Error("Approval not found")
    })()

  assertCanActOnApproval(viewingAs, approval)
  const updated = await db.markRunToolApprovalApproved(approvalId, actor)
  if (!updated || updated.status !== "approved") {
    throw new Error("Approval could not be granted")
  }

  await db.saveLog({
    run_id: approval.runId,
    level: "run",
    message: `Tool approval granted for ${approval.toolName} by ${actor}`,
    timestamp: new Date().toISOString(),
  })

  broadcast({
    type: EventType.ApprovalResolved,
    data: {
      runId: approval.runId,
      stepId: approval.stepId,
      approvalId,
      decision: "approved",
      by: actor,
    },
  })

  const resumedRunId = await orchestrator.resumeRun(approval.runId, viewingAs.session)
  return { ok: true, runId: approval.runId, resumedRunId }
}

export async function denyRunToolStep(
  orchestrator: AgentOrchestrator,
  approvalId: string,
  viewingAs: ViewingAs,
  reason?: string
): Promise<{ ok: true; runId: string }> {
  const actor = requireSessionUpn(viewingAs.session)
  const approval =
    await db.getRunToolApproval(approvalId) ??
    (() => {
      throw new Error("Approval not found")
    })()

  assertCanActOnApproval(viewingAs, approval)
  const updated = await db.markRunToolApprovalDenied(approvalId, actor)
  if (!updated || updated.status !== "denied") {
    throw new Error("Approval could not be denied")
  }

  await orchestrator.cancelRun(approval.runId)
  await db.markRunCancelled(approval.runId)

  await db.saveLog({
    run_id: approval.runId,
    level: "run:warning",
    message: `Tool approval denied for ${approval.toolName} by ${actor}`,
    timestamp: new Date().toISOString(),
  })

  broadcast({
    type: EventType.ApprovalResolved,
    data: {
      runId: approval.runId,
      stepId: approval.stepId,
      approvalId,
      decision: "denied",
      by: actor,
      reason: reason ?? null,
    },
  })

  broadcast({
    type: EventType.RunCancelled,
    data: { runId: approval.runId, reason: reason ?? "approval denied" },
  })

  return { ok: true, runId: approval.runId }
}

/** Pending approvals for Viewing as owner's waiting runs. */
export async function listPendingToolApprovalsForViewingAs(
  viewingAs: ViewingAs,
): Promise<db.RunToolApprovalRecord[]> {
  requireSessionUpn(viewingAs.session)
  const runs = await db.listRunsWithUsageForUser({ upn: viewingAs.viewingAsUpn }, 200)
  const runIds = runs
    .filter((run) => run.status === "waiting_for_approval")
    .map((run) => run.id)
  return await db.listPendingRunToolApprovalsForRuns(runIds)
}

export async function consumeMatchingToolGrant(
  runId: string,
  parentRunId: string | null | undefined,
  toolName: string,
  args: Record<string, unknown>
): Promise<void> {
  const grantRunIds = [runId, parentRunId].filter((id): id is string => !!id)
  const key = stableArgsKey(args)
  const match = (await db.listApprovedToolGrantsForRuns(grantRunIds)).find(
    (grant) => grant.toolName === toolName && stableArgsKey(grant.args) === key
  )
  if (match) await db.consumeRunToolApprovalGrant(match.id)
}
