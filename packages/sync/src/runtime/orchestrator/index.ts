/**
 * Sync orchestration — public barrel.
 *
 * Spine: `preview.ts`, `execute.ts`, `apply.ts`, `archive.ts`, `search.ts`, `plan-table.ts`
 * Concept folders: `metadata/`, `flow/`, `gates/`, `db/`
 */

export type { SyncEvent, SyncEventSink } from "../../ports/events.js"
export type { SyncRunFinishInput, SyncRunSink, SyncRunStartInput } from "../../ports/run-sink.js"
export { configureSyncEventSink } from "../events.js"
export { configureSyncRunSink } from "../run-sink.js"
export { configureSyncOrchestrator } from "./db/db-helpers.js"
export { executeSync } from "./execute.js"
export { previewSync, type PreviewInput } from "./preview.js"
export {
  resolveSyncEntitySearch,
  searchEntities,
  type EntitySearchMode,
  type EntitySearchResult
} from "./search.js"
export type { ExecuteOptions, ExecuteProgress, SyncExecuteResult } from "./types.js"
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
