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
  TableStarted:  "table-started",
  TableProgress: "table-progress",
  TableDone:     "table-done",
  Completed:     "completed",
  Failed:        "failed",
} as const

export type SyncProgressKind = (typeof SyncProgressKind)[keyof typeof SyncProgressKind]

export const SYNC_PROGRESS_KINDS: ReadonlyArray<SyncProgressKind> =
  Object.values(SyncProgressKind)

export const isSyncProgressKind = (value: unknown): value is SyncProgressKind =>
  typeof value === "string" && (SYNC_PROGRESS_KINDS as readonly string[]).includes(value)
