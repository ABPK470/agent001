/**
 * Sync orchestration — public barrel.
 *
 * Re-exports the public surface from the `orchestrator/` submodules so
 * existing imports of `../sync/orchestrator.js` continue to work
 * unchanged.
 *
 * Implementation lives in:
 *  - orchestrator/preview.ts         — previewSync, PreviewInput
 *  - orchestrator/execute.ts         — executeSync, ExecuteOptions, ExecuteProgress
 *  - orchestrator/execute-pipeline.ts — post-tx contract sproc choreography
 *  - orchestrator/metadata-sync.ts   — in-tx FK toggle + MERGE/DELETE loop
 *  - orchestrator/apply.ts           — applyInsertsUpdates / applyDeletes / fetchPkColumns
 *  - orchestrator/archive.ts         — trigger probing + archive emission
 *  - orchestrator/drift.ts           — revalidatePlanDrift
 *  - orchestrator/search.ts          — searchEntities, fetchEntityDisplayName, expandTreeIds
 *  - orchestrator/db-helpers.ts      — qtable, sqlLiteral, trackedQuery/Execute, projectRoot state
 *
 * The split was driven by Phase 2 of the agent maintainability refactor
 * (no public API change; behaviour preserved).
 */

export { configureSyncEventSink, type SyncEvent, type SyncEventSink } from "../sync-events.js"
export { configureSyncRunSink, type SyncRunFinishInput, type SyncRunSink, type SyncRunStartInput } from "../sync-run-sink.js"
export { configureSyncOrchestrator } from "./db-helpers.js"
export { executeSync } from "./execute.js"
export { previewSync, type PreviewInput } from "./preview.js"
export { searchEntities, type EntitySearchResult } from "./search.js"
export type { ExecuteOptions, ExecuteProgress } from "./types.js"

