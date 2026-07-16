/**
 * Sync-pipeline wire-format enums shared by agent + server (DB column,
 * SSE event payload).
 *
 * Internal sync-only enums (EnvRole, EnvAccessMode, DiscoverySource,
 * SyncOperationType, SyncPlanChangeType, SyncRecipeDiscrepancyKind)
 * stay in the agent package — they don't cross the wire and are only
 * consumed inside the agent's sync engine.
 */

/** Sync run lifecycle status (DB persisted in `sync_runs.status`). */
export const SyncRunStatus = {
  Started: "started",
  Preview: "preview",
  Success: "success",
  Failed:  "failed",
  /** Audit gate returned stop — sync not required; not an error. */
  Skipped: "skipped",
  /** User or client aborted an in-flight execute. */
  Cancelled: "cancelled",
} as const

export type SyncRunStatus = (typeof SyncRunStatus)[keyof typeof SyncRunStatus]

export const SYNC_RUN_STATUSES: ReadonlyArray<SyncRunStatus> = Object.values(SyncRunStatus)

export const isSyncRunStatus = (value: unknown): value is SyncRunStatus =>
  typeof value === "string" && (SYNC_RUN_STATUSES as readonly string[]).includes(value)

/**
 * Discriminator for the `ExecuteProgress` callback emitted by the sync
 * orchestrator. Wire-format: shipped in SSE traces consumed by the
 * route, CLI, and tests.
 */
export const SyncProgressKind = {
  Started:       "started",
  Step:          "step",
  /** Post-metadata deploy pipeline step (contract createDataset, ETL, etc.). */
  DeployStep:    "deploy-step",
  TableStarted:  "table-started",
  TableProgress: "table-progress",
  TableDone:     "table-done",
  Completed:     "completed",
  /** Audit gate returned stop — synchronization not required. */
  Skipped:       "skipped",
  Failed:        "failed",
} as const

/** Status for `deploy-step` progress events. */
export const SyncDeployStepStatus = {
  Started: "started",
  Done:    "done",
  Failed:  "failed",
  Skipped: "skipped",
} as const

export type SyncDeployStepStatus = (typeof SyncDeployStepStatus)[keyof typeof SyncDeployStepStatus]

export type SyncProgressKind = (typeof SyncProgressKind)[keyof typeof SyncProgressKind]

export const SYNC_PROGRESS_KINDS: ReadonlyArray<SyncProgressKind> =
  Object.values(SyncProgressKind)

export const isSyncProgressKind = (value: unknown): value is SyncProgressKind =>
  typeof value === "string" && (SYNC_PROGRESS_KINDS as readonly string[]).includes(value)
