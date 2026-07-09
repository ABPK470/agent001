/**
 * Operation log — turns raw event_log rows into a browsable history tree.
 *
 * Used by GET /api/operations and the operations SSE stream in the dashboard.
 * The UI shows pipelines (agent runs, sync jobs, system noise), each with
 * activities (steps, tables, lifecycle) and the underlying events.
 */

export { listOperations } from "./list-operations.js"
export type {
  ListOperationsOpts,
  OperationActivity,
  OperationEvent,
  OperationPipeline
} from "./types.js"
export { OperationKind, OperationStatus } from "./types.js"
