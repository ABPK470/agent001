// ── Event types ──────────────────────────────────────────────────

import { TrajectoryEditOperation, TrajectoryEventKind } from "../enums/trajectory.js"

export interface GoalEvent {
  kind: TrajectoryEventKind.Goal
  text: string
}

export interface ThinkingEvent {
  kind: TrajectoryEventKind.Thinking
  text: string
}

export interface ToolCallEvent {
  kind: TrajectoryEventKind.ToolCall
  tool: string
  argsSummary: string
  argsFormatted: string
}

export interface ToolResultEvent {
  kind: TrajectoryEventKind.ToolResult
  text: string
}

export interface ToolErrorEvent {
  kind: TrajectoryEventKind.ToolError
  text: string
}

export interface IterationEvent {
  kind: TrajectoryEventKind.Iteration
  current: number
  max: number
}

export interface DelegationStartEvent {
  kind: TrajectoryEventKind.DelegationStart
  childGoal: string
  childRunId: string
}

export interface DelegationEndEvent {
  kind: TrajectoryEventKind.DelegationEnd
  childRunId: string
  result: string
}

export interface AnswerEvent {
  kind: TrajectoryEventKind.Answer
  text: string
}

export interface ErrorEvent {
  kind: TrajectoryEventKind.Error
  text: string
}

export interface UsageEvent {
  kind: TrajectoryEventKind.Usage
  iterationTokens: number
  totalTokens: number
  promptTokens: number
  completionTokens: number
  llmCalls: number
}

export interface DelegationIterationEvent {
  kind: TrajectoryEventKind.DelegationIteration
  depth: number
  iteration: number
  maxIterations: number
}

export interface DelegationParallelStartEvent {
  kind: TrajectoryEventKind.DelegationParallelStart
  depth: number
  taskCount: number
  goals: string[]
}

export interface DelegationParallelEndEvent {
  kind: TrajectoryEventKind.DelegationParallelEnd
  depth: number
  taskCount: number
  fulfilled: number
  rejected: number
}

export interface SystemPromptEvent {
  kind: TrajectoryEventKind.SystemPrompt
  text: string
}

export interface ToolsResolvedEvent {
  kind: TrajectoryEventKind.ToolsResolved
  tools: Array<{ name: string; description: string; parameters?: Record<string, unknown> }>
}

export interface LlmRequestEvent {
  kind: TrajectoryEventKind.LlmRequest
  iteration: number
  messageCount: number
  toolCount: number
  messages: Array<{ role: string; content: string | null; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; toolCallId: string | null }>
}

export interface LlmResponseEvent {
  kind: TrajectoryEventKind.LlmResponse
  iteration: number
  durationMs: number
  content: string | null
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null
}

export interface PlannerValidationRemediatedEvent {
  kind: TrajectoryEventKind.PlannerValidationRemediated
  diagnostics: Array<{ code: string; message: string }>
}

export interface UserInputRequestEvent {
  kind: TrajectoryEventKind.UserInputRequest
  question: string
  options?: string[]
  sensitive?: boolean
}

export interface UserInputResponseEvent {
  kind: TrajectoryEventKind.UserInputResponse
  text: string
}

/** Discriminated union of all trajectory events. */
export type TrajectoryEvent =
  | GoalEvent
  | ThinkingEvent
  | ToolCallEvent
  | ToolResultEvent
  | ToolErrorEvent
  | IterationEvent
  | DelegationStartEvent
  | DelegationEndEvent
  | AnswerEvent
  | ErrorEvent
  | UsageEvent
  | DelegationIterationEvent
  | DelegationParallelStartEvent
  | DelegationParallelEndEvent
  | SystemPromptEvent
  | ToolsResolvedEvent
  | LlmRequestEvent
  | LlmResponseEvent
  | PlannerValidationRemediatedEvent
  | UserInputRequestEvent
  | UserInputResponseEvent

// ── Trajectory ───────────────────────────────────────────────────

export interface Trajectory {
  runId: string
  events: Array<{ seq: number; event: TrajectoryEvent; timestamp: string }>
}

/**
 * Mutation: alter the trajectory before replay to test resilience.
 *   - drop(seq)        — remove an event at sequence number
 *   - replace(seq, ev) — swap an event for a different one
 *   - inject(seq, ev)  — insert a new event before the given seq
 */
export type Mutation =
  | { type: TrajectoryEditOperation.Drop; seq: number }
  | { type: TrajectoryEditOperation.Replace; seq: number; event: TrajectoryEvent }
  | { type: TrajectoryEditOperation.Inject; seq: number; event: TrajectoryEvent }
