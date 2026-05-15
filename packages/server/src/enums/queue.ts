/**
 * Server-only enums for the `queue` domain.
 */

/** Run scheduling priority class for the in-process queue. */
export const RunPriority = {
  Critical: "critical",
  High:     "high",
  Normal:   "normal",
  Low:      "low",
} as const

export type RunPriority = (typeof RunPriority)[keyof typeof RunPriority]

export const RUN_PRIORITIES: ReadonlyArray<RunPriority> = Object.values(RunPriority)

export const isRunPriority = (value: unknown): value is RunPriority =>
  typeof value === "string" && (RUN_PRIORITIES as readonly string[]).includes(value)
