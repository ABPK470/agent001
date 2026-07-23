/**
 * Sync subsystem — public API.
 *
 * Outside this package, import only from `@mia/sync`.
 * Layers: domain / core / runtime / ports / tools / adapters / internal.
 */

export * from "./adapters/mssql/index.js"
export * from "./core/index.js"
export * from "./domain/index.js"
export * from "./runtime/index.js"
export * from "./tools/index.js"
export type { SqlEventInput, SyncEvent, SyncEventSink, SyncTelemetryContext } from "./ports/events.js"
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
} from "./ports/host.js"
export type { SyncRunFinishInput, SyncRunSink, SyncRunStartInput } from "./ports/run-sink.js"
export type { PublishedSyncDefinitionRegistry } from "./ports/published-definition-registry.js"
export type { SyncPublishReadinessPort } from "./ports/publish-readiness.js"
export { ALWAYS_PUBLISH_READY } from "./ports/publish-readiness.js"
