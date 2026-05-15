/**
 * Step lifecycle status — used for individual plan steps inside a run.
 *
 * Wire-format enum: persisted in DB, sent to UI in trace payloads,
 * compared with `===` across packages.
 */
export const StepStatus = {
  Pending: "pending",
  Running: "running",
  Completed: "completed",
  Failed: "failed",
  Skipped: "skipped",
  Blocked: "blocked",
} as const

export type StepStatus = (typeof StepStatus)[keyof typeof StepStatus]

export const STEP_STATUSES: ReadonlyArray<StepStatus> = Object.values(StepStatus)

export const isStepStatus = (value: unknown): value is StepStatus =>
  typeof value === "string" && (STEP_STATUSES as readonly string[]).includes(value)
