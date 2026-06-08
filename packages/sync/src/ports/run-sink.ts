import type { SyncPlan } from "../application/shell/plan-store.js"
import type { SyncRunStatus } from "../domain/enums.js"

export interface SyncRunStartInput {
  planId: string
  entityType: string
  entityId: string | number
  entityDisplayName: string | null
  source: string
  target: string
  actorUpn: string | null
  previewTotals: unknown
}

export interface SyncRunFinishInput {
  planId: string
  status: typeof SyncRunStatus.Success | typeof SyncRunStatus.Failed
  error?: string | null
  executeTotals?: unknown
  driftDetectedPct?: number | null
  durationMs: number
}

export interface SyncRunSink {
  start(input: SyncRunStartInput): void
  finish(input: SyncRunFinishInput): void
  savePlan?(plan: SyncPlan): void
  loadPlan?(planId: string): SyncPlan | null
}
