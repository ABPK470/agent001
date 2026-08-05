/**
 * Optimistic client state when an operator approves a parked tool step.
 *
 * Link the resume child to its parent *before* marking the parent cancelled —
 * otherwise collapseResumeRunChains cannot merge and chat flashes "Run cancelled".
 */

import { RunStatus } from "../enums"
import type { Run } from "../types"

export function applyOptimisticApprovalResume(
  parentRunId: string,
  resumedRunId: string,
  runs: readonly Run[],
  upsertRun: (run: Partial<Run> & { id: string }) => void,
  setActiveRun: (runId: string) => void,
): void {
  const parent = runs.find((r) => r.id === parentRunId)
  const now = new Date().toISOString()

  upsertRun({
    id: resumedRunId,
    status: RunStatus.Running,
    parentRunId,
    goal: parent?.goal ?? "",
    threadId: parent?.threadId,
    upn: parent?.upn,
    displayName: parent?.displayName,
    createdAt: now,
    completedAt: null,
    answer: null,
    error: null,
    streamingAnswer: parent?.streamingAnswer ?? "",
    trace: parent?.trace ?? [],
    stepCount: parent?.stepCount ?? 0,
    pendingWorkspaceChanges: parent?.pendingWorkspaceChanges ?? 0,
    totalTokens: parent?.totalTokens ?? 0,
    promptTokens: parent?.promptTokens ?? 0,
    completionTokens: parent?.completionTokens ?? 0,
    llmCalls: parent?.llmCalls ?? 0,
    auditTrail: parent?.auditTrail ?? [],
    stepData: parent?.stepData ?? [],
  })

  upsertRun({
    id: parentRunId,
    status: RunStatus.Cancelled,
    completedAt: now,
  })

  setActiveRun(resumedRunId)
}
