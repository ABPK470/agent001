/**
 * Sync-pipeline enums.
 *
 * Wire-format pieces (`SyncRunStatus`, `SyncProgressKind`) live in
 * `@mia/shared-enums` and are re-exported as a façade. Sync-only
 * internal enums stay here as `as const` objects (modern TS idiom —
 * tree-shakable, no reverse-lookup boilerplate).
 */

// ── Wire-format façade ──────────────────────────────────────────────────
export {
  SyncRunStatus,
  SYNC_RUN_STATUSES,
  isSyncRunStatus,
  SyncProgressKind,
  SYNC_PROGRESS_KINDS,
  isSyncProgressKind,
} from "@mia/shared-enums"

// ── Internal: agent-only sync engine enums ──────────────────────────────

/** Role an environment plays in a sync (source / target / both). */
export const EnvRole = {
  Source: "source",
  Target: "target",
  Both:   "both",
} as const
export type EnvRole = (typeof EnvRole)[keyof typeof EnvRole]
export const ENV_ROLES: ReadonlyArray<EnvRole> = Object.values(EnvRole)
export const isEnvRole = (value: unknown): value is EnvRole =>
  typeof value === "string" && (ENV_ROLES as readonly string[]).includes(value)

/** Default access mode applied to an environment (read-only vs read-write). */
export const EnvAccessMode = {
  ReadOnly:  "read_only",
  ReadWrite: "read_write",
} as const
export type EnvAccessMode = (typeof EnvAccessMode)[keyof typeof EnvAccessMode]
export const ENV_ACCESS_MODES: ReadonlyArray<EnvAccessMode> = Object.values(EnvAccessMode)
export const isEnvAccessMode = (value: unknown): value is EnvAccessMode =>
  typeof value === "string" && (ENV_ACCESS_MODES as readonly string[]).includes(value)

/** How a table was discovered as part of an entity dependency closure. */
export const DiscoverySource = {
  FkAndPipeline: "fk+pipeline",
  FkOnly:        "fk-only",
  PipelineOnly:  "pipeline-only",
} as const
export type DiscoverySource = (typeof DiscoverySource)[keyof typeof DiscoverySource]
export const DISCOVERY_SOURCES: ReadonlyArray<DiscoverySource> = Object.values(DiscoverySource)
export const isDiscoverySource = (value: unknown): value is DiscoverySource =>
  typeof value === "string" && (DISCOVERY_SOURCES as readonly string[]).includes(value)

/** Whether an event/route-prefix refers to a preview or an execute pass. */
export const SyncOperationType = {
  Preview: "preview",
  Execute: "execute",
} as const
export type SyncOperationType = (typeof SyncOperationType)[keyof typeof SyncOperationType]
export const SYNC_OPERATION_TYPES: ReadonlyArray<SyncOperationType> =
  Object.values(SyncOperationType)
export const isSyncOperationType = (value: unknown): value is SyncOperationType =>
  typeof value === "string" && (SYNC_OPERATION_TYPES as readonly string[]).includes(value)

/** Per-table change classification on a sync plan node. */
export const SyncPlanChangeType = {
  Unchanged: "unchanged",
  Updates:   "updates",
  Deletes:   "deletes",
  Inserts:   "inserts",
} as const
export type SyncPlanChangeType = (typeof SyncPlanChangeType)[keyof typeof SyncPlanChangeType]
export const SYNC_PLAN_CHANGE_TYPES: ReadonlyArray<SyncPlanChangeType> =
  Object.values(SyncPlanChangeType)
export const isSyncPlanChangeType = (value: unknown): value is SyncPlanChangeType =>
  typeof value === "string" && (SYNC_PLAN_CHANGE_TYPES as readonly string[]).includes(value)

/** How a table differs from the legacy pipeline's coverage. */
export const SyncRecipeDiscrepancyKind = {
  Leak:     "leak",
  Implicit: "implicit",
  Drift:    "drift",
} as const
export type SyncRecipeDiscrepancyKind =
  (typeof SyncRecipeDiscrepancyKind)[keyof typeof SyncRecipeDiscrepancyKind]
export const SYNC_RECIPE_DISCREPANCY_KINDS: ReadonlyArray<SyncRecipeDiscrepancyKind> =
  Object.values(SyncRecipeDiscrepancyKind)
export const isSyncRecipeDiscrepancyKind = (value: unknown): value is SyncRecipeDiscrepancyKind =>
  typeof value === "string" &&
  (SYNC_RECIPE_DISCREPANCY_KINDS as readonly string[]).includes(value)
