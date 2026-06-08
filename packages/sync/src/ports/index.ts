/**
 * Sync ports door.
 */

export { getMssqlConfig, getPool, type MssqlEntry } from "../adapters/mssql/index.js"
export type {
  SyncPlan,
  SyncPlanConflict,
  SyncPlanGraph,
  SyncPlanGraphNode,
  SyncPlanRowSample,
  SyncPlanTable,
  SyncPlanTableCounts,
  SyncPlanTotals
} from "../application/shell/plan-store.js"
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
  ToolResultArtifactState,
  ToolResultEnvelope
} from "./host.js"
export type { SyncRunFinishInput, SyncRunSink, SyncRunStartInput } from "./run-sink.js"
