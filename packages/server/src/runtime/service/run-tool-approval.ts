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

function assertCanActOnApproval(
  viewingAs: ViewingAs,
  approval: db.RunToolApprovalRecord
): void {
  const run = db.getRun(approval.runId)
  if (!run || !canAccessRun(viewingAs, run)) {
    throw new Error("Run not found")
  }
  if (approval.status !== "pending") {
    throw new Error(`Approval is already ${approval.status}`)
  }
}

export function approveRunToolStep(
  orchestrator: AgentOrchestrator,
  approvalId: string,
  viewingAs: ViewingAs,
): { ok: true; runId: string; resumedRunId: string | null } {
  const actor = requireSessionUpn(viewingAs.session)
  const approval =
    db.getRunToolApproval(approvalId) ??
    (() => {
      throw new Error("Approval not found")
    })()

  assertCanActOnApproval(viewingAs, approval)
  const updated = db.markRunToolApprovalApproved(approvalId, actor)
  if (!updated || updated.status !== "approved") {
    throw new Error("Approval could not be granted")
  }

  db.saveLog({
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

  const resumedRunId = orchestrator.resumeRun(approval.runId, viewingAs.session)
  return { ok: true, runId: approval.runId, resumedRunId }
}

export function denyRunToolStep(
  orchestrator: AgentOrchestrator,
  approvalId: string,
  viewingAs: ViewingAs,
  reason?: string
): { ok: true; runId: string } {
  const actor = requireSessionUpn(viewingAs.session)
  const approval =
    db.getRunToolApproval(approvalId) ??
    (() => {
      throw new Error("Approval not found")
    })()

  assertCanActOnApproval(viewingAs, approval)
  const updated = db.markRunToolApprovalDenied(approvalId, actor)
  if (!updated || updated.status !== "denied") {
    throw new Error("Approval could not be denied")
  }

  orchestrator.cancelRun(approval.runId)
  db.markRunCancelled(approval.runId)

  db.saveLog({
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
export function listPendingToolApprovalsForViewingAs(
  viewingAs: ViewingAs,
): db.RunToolApprovalRecord[] {
  requireSessionUpn(viewingAs.session)
  const runs = db.listRunsWithUsageForUser({ upn: viewingAs.viewingAsUpn }, 200)
  const runIds = runs
    .filter((run) => run.status === "waiting_for_approval")
    .map((run) => run.id)
  return db.listPendingRunToolApprovalsForRuns(runIds)
}

export function consumeMatchingToolGrant(
  runId: string,
  parentRunId: string | null | undefined,
  toolName: string,
  args: Record<string, unknown>
): void {
  const grantRunIds = [runId, parentRunId].filter((id): id is string => !!id)
  const key = stableArgsKey(args)
  const match = db.listApprovedToolGrantsForRuns(grantRunIds).find(
    (grant) => grant.toolName === toolName && stableArgsKey(grant.args) === key
  )
  if (match) db.consumeRunToolApprovalGrant(match.id)
}
