/**
 * Trajectory event-kind discriminators (server-side replay/scoring).
 *
 * Single source of truth for the 24-value `TrajectoryEvent.kind` and
 * the 3-value `Mutation.type` discriminants. Promoted from inline
 * string-literal unions so scorer / loader switch arms gain
 * exhaustiveness checking and no event-kind drift is possible.
 *
 * Wire-format compatibility: every literal value matches the previous
 * union member exactly, so persisted trajectories stay readable.
 *
 * @module
 */

// ── TrajectoryEventKind ───────────────────────────────────────────────────
export const TrajectoryEventKind = {
  Goal:                        "goal",
  Thinking:                    "thinking",
  ToolCall:                    "tool-call",
  ToolResult:                  "tool-result",
  ToolError:                   "tool-error",
  Iteration:                   "iteration",
  DelegationStart:             "delegation-start",
  DelegationEnd:               "delegation-end",
  Answer:                      "answer",
  Error:                       "error",
  Usage:                       "usage",
  DelegationIteration:         "delegation-iteration",
  DelegationParallelStart:     "delegation-parallel-start",
  DelegationParallelEnd:       "delegation-parallel-end",
  SystemPrompt:                "system-prompt",
  ToolsResolved:               "tools-resolved",
  ToolsFiltered:               "tools-filtered",
  LlmRequest:                  "llm-request",
  LlmResponse:                 "llm-response",
  PlannerValidationRemediated: "planner-validation-remediated",
  UserInputRequest:            "user-input-request",
  UserInputResponse:           "user-input-response",
} as const

export type TrajectoryEventKind = (typeof TrajectoryEventKind)[keyof typeof TrajectoryEventKind]

export const TRAJECTORY_EVENT_KINDS: ReadonlyArray<TrajectoryEventKind> = Object.values(TrajectoryEventKind)

export const isTrajectoryEventKind = (value: unknown): value is TrajectoryEventKind =>
  typeof value === "string" && (TRAJECTORY_EVENT_KINDS as readonly string[]).includes(value)

// ── TrajectoryEditOperation ───────────────────────────────────────────────
export const TrajectoryEditOperation = {
  Drop:    "drop",
  Replace: "replace",
  Inject:  "inject",
} as const

export type TrajectoryEditOperation = (typeof TrajectoryEditOperation)[keyof typeof TrajectoryEditOperation]

export const TRAJECTORY_EDIT_OPERATIONS: ReadonlyArray<TrajectoryEditOperation> = Object.values(TrajectoryEditOperation)

export const isTrajectoryEditOperation = (value: unknown): value is TrajectoryEditOperation =>
  typeof value === "string" && (TRAJECTORY_EDIT_OPERATIONS as readonly string[]).includes(value)
