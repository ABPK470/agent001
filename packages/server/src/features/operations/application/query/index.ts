/**
 * Operation log — turns raw event_log rows into a browsable history tree.
 *
 * Used by GET /api/operations and the operations SSE stream in the dashboard.
 * The UI shows pipelines (agent runs, sync jobs, system noise), each with
 * activities (steps, tables, lifecycle) and the underlying events.
 */

export { listOperations, OPERATIONS_PAGE_EVENT_LIMIT } from "./list-operations.js"
export type { ListOperationsResult } from "./types.js"
export { listOperationsForPlan } from "./list-operations-for-plan.js"
export { listOperationsForRun } from "./list-operations-for-run.js"
export type {
  ListOperationsOpts,
  OperationActivity,
  OperationEvent,
  OperationPipeline
} from "./types.js"
export { OperationKind, OperationStatus } from "./types.js"
