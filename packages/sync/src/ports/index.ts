/**
 * Sync ports — contracts only (no adapter implementations).
 */

export type {
  SyncPlan,
  SyncPlanChangeRow,
  SyncPlanChangeSet,
  SyncPlanConflict,
  SyncPlanGraph,
  SyncPlanGraphNode,
  SyncPlanRowSample,
  SyncPlanTable,
  SyncPlanTableStats,
  SyncPlanTotals
} from "../domain/plan.js"
export * from "../domain/enums.js"
export type { EnvAccessMode, EnvRole } from "../domain/enums.js"
export type { EnvOperation, LoadSyncEnvironmentsResult, SyncEnvironment } from "../domain/environments.js"
export type { SqlEventInput, SyncEvent, SyncEventSink, SyncTelemetryContext } from "./events.js"
export type {
  MssqlAccessHost,
  MssqlHost,
  SyncEnvironmentRegistryHost,
  SyncEventHost,
  SyncHost,
  SyncPlanStoreHost,
  SyncProjectRootHost,
  SyncRunHost,
  SyncRuntimeHost,
  SyncStateHost,
  Tool,
  ToolMetadata,
  ExecutableTool,
  MssqlConnectorPool,
  MssqlPoolProvider,
  ToolResultArtifactState,
  ToolResultEnvelope
} from "./host.js"
export type { SyncRunFinishInput, SyncRunSink, SyncRunStartInput } from "./run-sink.js"
export type { PublishedSyncDefinitionRegistry } from "./published-definition-registry.js"
export type { SyncPublishReadinessPort } from "./publish-readiness.js"
export { ALWAYS_PUBLISH_READY } from "./publish-readiness.js"
