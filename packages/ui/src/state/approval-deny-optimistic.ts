import { RunStatus } from "../enums"
import { formatApprovalDeniedCancelDetail } from "../lib/approval-copy"
import {
  appendApprovalDeniedTraceEntry,
  type ApprovalDenial,
} from "../lib/approval-trace"
import type { Run } from "../types"

export interface OptimisticApprovalDenial extends ApprovalDenial {
  runId: string
}

export function applyOptimisticApprovalDeny(
  denial: OptimisticApprovalDenial,
  runs: readonly Run[],
  upsertRun: (run: Partial<Run> & { id: string }) => void,
): void {
  const run = runs.find((candidate) => candidate.id === denial.runId)
  if (!run) return

  const now = new Date().toISOString()
  upsertRun({
    id: denial.runId,
    status: RunStatus.Cancelled,
    completedAt: now,
    error: formatApprovalDeniedCancelDetail(denial.toolName, denial.reason),
    streamingAnswer: "",
    trace: appendApprovalDeniedTraceEntry(run.trace ?? [], denial),
  })
}
