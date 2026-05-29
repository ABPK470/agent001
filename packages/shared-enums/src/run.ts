/**
 * Run lifecycle status. Wire-format enum: written to the
 * `runs.status` SQLite column, sent in HTTP/SSE payloads, compared
 * with `===` in the UI.
 *
 * The transition map is encoded in
 * `packages/agent/src/engine/models.ts:74-78` — keep both in sync if
 * you add a state.
 *
 * Pattern: `as const` object + derived union type. Modern TypeScript
 * idiom (replaces `enum`): tree-shakable, no reverse-lookup boilerplate,
 * `Object.values` produces the runtime list with no manual duplication.
 */
export const RunStatus = {
  Pending: "pending",
  Planning: "planning",
  Running: "running",
  WaitingForApproval: "waiting_for_approval",
  Completed: "completed",
  Failed: "failed",
  Cancelled: "cancelled",
  /** Terminal. Set on boot for any non-terminal row when the server
   *  restarted mid-run. Distinct from Failed (an agent-level error)
   *  so the UI can label it accurately and the user knows the loop
   *  was interrupted by an external event, not a logic failure.
   *  Resumable from checkpoint, never auto-resumed. */
  Crashed: "crashed",
} as const

export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus]

/** Every legal RunStatus value — used at boundaries (DB writes, route
 *  validators, lockdown lints). */
export const RUN_STATUSES: ReadonlyArray<RunStatus> = Object.values(RunStatus)

export const isRunStatus = (value: unknown): value is RunStatus =>
  typeof value === "string" && (RUN_STATUSES as readonly string[]).includes(value)
