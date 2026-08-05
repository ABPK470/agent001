import { EventType } from "@mia/agent"
import {
  normalizeToolApprovalGrantScope,
  ToolApprovalGrantScope,
  type ToolApprovalGrantScope as GrantScope,
} from "@mia/shared-enums"
import { stripRuntimeToolArgs, type TraceEntry } from "@mia/shared-types"

import { canAccessRun, requireSessionUpn } from "../../api/auth/service/access.js"
import type { ViewingAs } from "../../api/auth/service/viewing-as.js"
import { broadcast } from "../../infra/events/broadcaster.js"
import * as db from "../../infra/persistence/sqlite.js"
import { TraceEventKind } from "../../internal/enums/trace.js"
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

/** Walk parent_run_id toward the root (leaf first). */
export async function resumeChainRunIds(leafRunId: string): Promise<string[]> {
  const ids: string[] = [leafRunId]
  const guard = new Set<string>([leafRunId])
  let currentId: string | null = leafRunId
  while (currentId) {
    const run = await db.getRun(currentId)
    const parentId = run?.parent_run_id ?? null
    if (!parentId || guard.has(parentId)) break
    guard.add(parentId)
    ids.push(parentId)
    currentId = parentId
  }
  return ids
}

/** Clear leftover approved grants when a resume chain truly ends. */
export async function expireToolApprovalGrantsForRunChain(leafRunId: string): Promise<void> {
  const ids = await resumeChainRunIds(leafRunId)
  await db.expireApprovedToolGrantsForRuns(ids)
}

export async function approveRunToolStep(
  orchestrator: AgentOrchestrator,
  approvalId: string,
  viewingAs: ViewingAs,
  grantScope: GrantScope = ToolApprovalGrantScope.Instance,
): Promise<{ ok: true; runId: string; resumedRunId: string | null; grantScope: GrantScope }> {
  const actor = requireSessionUpn(viewingAs.session)
  const scope = normalizeToolApprovalGrantScope(grantScope)
  const approval =
    await db.getRunToolApproval(approvalId) ??
    (() => {
      throw new Error("Approval not found")
    })()

  await assertCanActOnApproval(viewingAs, approval)
  const updated = await db.markRunToolApprovalApproved(approvalId, actor, scope)
  if (!updated || updated.status !== "approved") {
    throw new Error("Approval could not be granted")
  }

  const scopeLabel =
    scope === ToolApprovalGrantScope.Run ? "for this run" : "for this call"
  await db.saveLog({
    run_id: approval.runId,
    level: "run",
    message: `Tool approval granted ${scopeLabel} for ${approval.toolName} by ${actor}`,
    timestamp: new Date().toISOString(),
  })

  const resumedRunId = await orchestrator.resumeRun(approval.runId, viewingAs.session)

  broadcast({
    type: EventType.ApprovalResolved,
    data: {
      runId: approval.runId,
      stepId: approval.stepId,
      approvalId,
      decision: "approved",
      by: actor,
      grantScope: scope,
      resumedRunId: resumedRunId ?? null,
    },
  })

  return { ok: true, runId: approval.runId, resumedRunId, grantScope: scope }
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

  await assertCanActOnApproval(viewingAs, approval)
  const updated = await db.markRunToolApprovalDenied(approvalId, actor)
  if (!updated || updated.status !== "denied") {
    throw new Error("Approval could not be denied")
  }

  await orchestrator.cancelRun(approval.runId)
  await db.markRunCancelled(approval.runId)
  await expireToolApprovalGrantsForRunChain(approval.runId)

  const deniedReason = reason?.trim()
  const approvalDeniedTrace = {
    kind: TraceEventKind.ApprovalDenied,
    approvalId,
    stepId: approval.stepId,
    toolName: approval.toolName,
    ...(deniedReason ? { reason: deniedReason } : {}),
  } satisfies Extract<TraceEntry, { kind: "approval-denied" }>
  await db.appendTraceEntry(approval.runId, approvalDeniedTrace)

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
      reason: deniedReason || null,
      toolName: approval.toolName,
    },
  })

  broadcast({
    type: EventType.RunCancelled,
    data: {
      runId: approval.runId,
      reason: deniedReason || null,
      toolName: approval.toolName,
    },
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

/**
 * Instance grants are one-shot. Run grants stay approved until the leaf ends.
 */
export async function consumeMatchingToolGrant(
  runId: string,
  parentRunId: string | null | undefined,
  toolName: string,
  args: Record<string, unknown>
): Promise<void> {
  const grantRunIds = [runId, parentRunId].filter((id): id is string => !!id)
  const key = stableArgsKey(args)
  const match = (await db.listApprovedToolGrantsForRuns(grantRunIds)).find((grant) => {
    if (grant.toolName !== toolName) return false
    if (grant.grantScope === ToolApprovalGrantScope.Run) return false
    return stableArgsKey(grant.args) === key
  })
  if (match) await db.consumeRunToolApprovalGrant(match.id)
}
