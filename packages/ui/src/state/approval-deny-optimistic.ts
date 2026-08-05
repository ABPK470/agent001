/**
 * Optimistic client state when an operator denies a parked tool step.
 *
 * Denial is cancellation — rewrite wait markers to an approval-denied note
 * and set a cancel reason (never a Fail/Error terminal).
 */

import { RunStatus } from "../enums"
import {
  formatApprovalDeniedCancelDetail,
  rewriteApprovalWaitEntriesToDenied,
} from "../lib/approval-wait-copy"
import type { Run } from "../types"

export function applyOptimisticApprovalDeny(
  runId: string,
  toolName: string,
  reason: string | null | undefined,
  runs: readonly Run[],
  upsertRun: (run: Partial<Run> & { id: string }) => void,
): void {
  const run = runs.find((r) => r.id === runId)
  const now = new Date().toISOString()
  const detail = formatApprovalDeniedCancelDetail(toolName, reason)
  upsertRun({
    id: runId,
    status: RunStatus.Cancelled,
    completedAt: now,
    error: detail,
    streamingAnswer: "",
    trace: rewriteApprovalWaitEntriesToDenied(run?.trace ?? [], toolName, reason),
  })
}
