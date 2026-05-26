/**
 * Contract door for the new `ports/` cluster.
 *
 * This barrel is intentionally type-focused at the start. It lets the new
 * structure become importable without moving the existing implementation files
 * yet.
 */

export type { EnvAccessMode, EnvOperation, EnvRole, LoadSyncEnvironmentsResult, SyncEnvironment } from "../environments.js"
export type {
    SyncPlan,
    SyncPlanChangeType,
    SyncPlanConflict,
    SyncPlanGraph,
    SyncPlanGraphNode,
    SyncPlanRowSample,
    SyncPlanTable,
    SyncPlanTableCounts,
    SyncPlanTotals
} from "../plan-store.js"
export type { SqlEventInput, SyncEvent, SyncEventSink, SyncTelemetryContext } from "../sync-events.js"
export type { SyncRunFinishInput, SyncRunSink, SyncRunStartInput } from "../sync-run-sink.js"
