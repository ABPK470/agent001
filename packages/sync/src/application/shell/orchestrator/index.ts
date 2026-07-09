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
 *  - orchestrator/post-metadata-pipeline.ts — post-metadata step dispatcher
 *  - orchestrator/metadata-sync.ts   — in-tx FK toggle + changeSet MERGE/DELETE
 *  - orchestrator/metadata-scope.ts  — constraintRelaxationTables / dataMovementTables
 *  - orchestrator/plan-table.ts        — changeSet helpers + validatePlan
 *  - orchestrator/apply.ts           — changeSet-driven MERGE / DELETE
 *  - orchestrator/archive.ts         — trigger probing + archive emission
 *  - orchestrator/root-parent-preflight.ts — universal root parent check (preview + execute)
 *  - orchestrator/search.ts          — searchEntities, fetchEntityDisplayName, expandTreeIds
 *  - orchestrator/db-helpers.ts      — qtable, sqlLiteral, trackedQuery/Execute, projectRoot state
 *
 * The split was driven by Phase 2 of the agent maintainability refactor
 * (no public API change; behaviour preserved).
 */

export type { SyncEvent, SyncEventSink } from "../../../ports/events.js"
export type { SyncRunFinishInput, SyncRunSink, SyncRunStartInput } from "../../../ports/run-sink.js"
export { configureSyncEventSink } from "../events.js"
export { configureSyncRunSink } from "../run-sink.js"
export { configureSyncOrchestrator } from "./db-helpers.js"
export { executeSync } from "./execute.js"
export { previewSync, type PreviewInput } from "./preview.js"
export {
  resolveSyncEntitySearch,
  searchEntities,
  type EntitySearchMode,
  type EntitySearchResult
} from "./search.js"
export type { ExecuteOptions, ExecuteProgress } from "./types.js"
export {
  changeRowsAsPkHash,
  computePlanTotals,
  deleteRows,
  hasChangeSetWork,
  hasUpsertWork,
  movementFromChangeSet,
  movementOfTable,
  tableHasMovement,
  tableMovementTotal,
  upsertRows,
  validatePlan
} from "./plan-table.js"
