/**
 * Sync subsystem — public API.
 *
 * Outside this folder, import from `@mia/sync` or `./index.js` only.
 * Files inside this package (including `domain/*` and `application/*`)
 * are private implementation details.
 */

export * from "./adapters/mssql/index.js"
export * from "./application/index.js"
export * from "./domain/index.js"
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
    ToolResultArtifactState,
    ToolResultEnvelope
} from "./ports/host.js"
export type { SyncRunFinishInput, SyncRunSink, SyncRunStartInput } from "./ports/run-sink.js"

