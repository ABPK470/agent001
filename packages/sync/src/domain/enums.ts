export { EventType, SyncDeployStepStatus, SyncProgressKind, SyncRunStatus } from "@mia/shared-enums"

export const EnvRole = {
  Source: "source",
  Target: "target",
  Both: "both"
} as const
export type EnvRole = (typeof EnvRole)[keyof typeof EnvRole]
export const ENV_ROLES: ReadonlyArray<EnvRole> = Object.values(EnvRole)
export const isEnvRole = (value: unknown): value is EnvRole =>
  typeof value === "string" && (ENV_ROLES as readonly string[]).includes(value)

export const EnvAccessMode = {
  ReadOnly: "read_only",
  ReadWrite: "read_write"
} as const
export type EnvAccessMode = (typeof EnvAccessMode)[keyof typeof EnvAccessMode]
export const ENV_ACCESS_MODES: ReadonlyArray<EnvAccessMode> = Object.values(EnvAccessMode)
export const isEnvAccessMode = (value: unknown): value is EnvAccessMode =>
  typeof value === "string" && (ENV_ACCESS_MODES as readonly string[]).includes(value)

export const DiscoverySource = {
  FkAndPipeline: "fk+pipeline",
  FkOnly: "fk-only",
  PipelineOnly: "pipeline-only",
  Manual: "manual"
} as const
export type DiscoverySource = (typeof DiscoverySource)[keyof typeof DiscoverySource]
export const DISCOVERY_SOURCES: ReadonlyArray<DiscoverySource> = Object.values(DiscoverySource)
export const isDiscoverySource = (value: unknown): value is DiscoverySource =>
  typeof value === "string" && (DISCOVERY_SOURCES as readonly string[]).includes(value)

export const SyncOperationType = {
  Preview: "preview",
  Execute: "execute"
} as const
export type SyncOperationType = (typeof SyncOperationType)[keyof typeof SyncOperationType]
export const SYNC_OPERATION_TYPES: ReadonlyArray<SyncOperationType> = Object.values(SyncOperationType)
export const isSyncOperationType = (value: unknown): value is SyncOperationType =>
  typeof value === "string" && (SYNC_OPERATION_TYPES as readonly string[]).includes(value)

export const SyncPlanChangeType = {
  Unchanged: "unchanged",
  Updates: "updates",
  Deletes: "deletes",
  Inserts: "inserts"
} as const
export type SyncPlanChangeType = (typeof SyncPlanChangeType)[keyof typeof SyncPlanChangeType]
export const SYNC_PLAN_CHANGE_TYPES: ReadonlyArray<SyncPlanChangeType> = Object.values(SyncPlanChangeType)
export const isSyncPlanChangeType = (value: unknown): value is SyncPlanChangeType =>
  typeof value === "string" && (SYNC_PLAN_CHANGE_TYPES as readonly string[]).includes(value)

export const SyncRecipeDiscrepancyKind = {
  Leak: "leak",
  Implicit: "implicit",
  Drift: "drift"
} as const
export type SyncRecipeDiscrepancyKind =
  (typeof SyncRecipeDiscrepancyKind)[keyof typeof SyncRecipeDiscrepancyKind]
export const SYNC_RECIPE_DISCREPANCY_KINDS: ReadonlyArray<SyncRecipeDiscrepancyKind> =
  Object.values(SyncRecipeDiscrepancyKind)
export const isSyncRecipeDiscrepancyKind = (value: unknown): value is SyncRecipeDiscrepancyKind =>
  typeof value === "string" && (SYNC_RECIPE_DISCREPANCY_KINDS as readonly string[]).includes(value)

export const PostMetadataActionKind = {
  DatasetDeploy: "datasetDeploy",
  RulesDeploy: "rulesDeploy",
  PipelineRegister: "pipelineRegister",
  MetaRefresh: "metaRefresh",
  PipelineStart: "pipelineStart",
  HandleDependencies: "handleDependencies",
  SyncDate: "syncDate",
  DeployDate: "deployDate"
} as const
export type PostMetadataActionKind = (typeof PostMetadataActionKind)[keyof typeof PostMetadataActionKind]
export const POST_METADATA_ACTION_KINDS: ReadonlyArray<PostMetadataActionKind> =
  Object.values(PostMetadataActionKind)
export const isPostMetadataActionKind = (value: unknown): value is PostMetadataActionKind =>
  typeof value === "string" && (POST_METADATA_ACTION_KINDS as readonly string[]).includes(value)

export const ToolOutcomeSeverity = {
  Info: "info",
  Recoverable: "recoverable",
  Fatal: "fatal"
} as const
export type ToolOutcomeSeverity = (typeof ToolOutcomeSeverity)[keyof typeof ToolOutcomeSeverity]

export const ToolControlDirective = {
  Continue: "continue",
  RetryAfterInspection: "retry_after_inspection",
  AbortRound: "abort_round",
  AbortLoop: "abort_loop"
} as const
export type ToolControlDirective = (typeof ToolControlDirective)[keyof typeof ToolControlDirective]
