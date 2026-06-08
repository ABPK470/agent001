/**
 * Server-only enums for the `run-workspace` domain.
 */

/** Coarse classification of a run's primary task. */
export const RunTaskType = {
  CodeGeneration: "code_generation",
  AnalysisOrChat: "analysis_or_chat"
} as const

export type RunTaskType = (typeof RunTaskType)[keyof typeof RunTaskType]

export const RUN_TASK_TYPES: ReadonlyArray<RunTaskType> = Object.values(RunTaskType)

export const isRunTaskType = (value: unknown): value is RunTaskType =>
  typeof value === "string" && (RUN_TASK_TYPES as readonly string[]).includes(value)

/** Runtime profile a run executes under (developer vs hosted). */
export const RunProfile = {
  Developer: "developer",
  Hosted: "hosted"
} as const

export type RunProfile = (typeof RunProfile)[keyof typeof RunProfile]

export const RUN_PROFILES: ReadonlyArray<RunProfile> = Object.values(RunProfile)

export const isRunProfile = (value: unknown): value is RunProfile =>
  typeof value === "string" && (RUN_PROFILES as readonly string[]).includes(value)
