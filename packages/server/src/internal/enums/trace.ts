/**
 * Trace event-kind discriminators for persisted run event streams.
 *
 * Single source of truth for `kind` literals written into `trace_entries`
 * via `saveTrace`. Exhaustiveness on switch arms keeps event-kind drift
 * from landing. Wire values are stable string literals (unchanged by rename).
 *
 * @module
 */

export const TraceEventKind = {
  Goal: "goal",
  Thinking: "thinking",
  ToolCall: "tool-call",
  ToolResult: "tool-result",
  ToolError: "tool-error",
  Iteration: "iteration",
  DelegationStart: "delegation-start",
  DelegationEnd: "delegation-end",
  Answer: "answer",
  Error: "error",
  Usage: "usage",
  DelegationIteration: "delegation-iteration",
  DelegationParallelStart: "delegation-parallel-start",
  DelegationParallelEnd: "delegation-parallel-end",
  SystemPrompt: "system-prompt",
  ToolsResolved: "tools-resolved",
  ToolsFiltered: "tools-filtered",
  LlmRequest: "llm-request",
  LlmResponse: "llm-response",
  PlannerValidationRemediated: "planner-validation-remediated",
  UserInputRequest: "user-input-request",
  UserInputResponse: "user-input-response",
  ClarificationDetected: "clarification-detected",
  ClarificationResolved: "clarification-resolved",
  ClarificationLlmPlannerInvoked: "clarification-llm-planner-invoked"
} as const

export type TraceEventKind = (typeof TraceEventKind)[keyof typeof TraceEventKind]

export const TRACE_EVENT_KINDS: ReadonlyArray<TraceEventKind> = Object.values(TraceEventKind)

export const isTraceEventKind = (value: unknown): value is TraceEventKind =>
  typeof value === "string" && (TRACE_EVENT_KINDS as readonly string[]).includes(value)
