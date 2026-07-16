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
  status:
    | typeof SyncRunStatus.Success
    | typeof SyncRunStatus.Failed
    | typeof SyncRunStatus.Skipped
    | typeof SyncRunStatus.Cancelled
  error?: string | null
  executeTotals?: unknown
  durationMs: number
}

export interface SyncRunSink {
  start(input: SyncRunStartInput): void
  finish(input: SyncRunFinishInput): void
  /** Optional host-level actor when the plan body does not carry `userUpn`. */
  savePlan?(plan: SyncPlan, actorUpn?: string | null): void
  loadPlan?(planId: string): SyncPlan | null
}
