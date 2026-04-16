// ── Event types ──────────────────────────────────────────────────

export interface GoalEvent {
  kind: "goal"
  text: string
}

export interface ThinkingEvent {
  kind: "thinking"
  text: string
}

export interface ToolCallEvent {
  kind: "tool-call"
  tool: string
  argsSummary: string
  argsFormatted: string
}

export interface ToolResultEvent {
  kind: "tool-result"
  text: string
}

export interface ToolErrorEvent {
  kind: "tool-error"
  text: string
}

export interface IterationEvent {
  kind: "iteration"
  current: number
  max: number
}

export interface DelegationStartEvent {
  kind: "delegation-start"
  childGoal: string
  childRunId: string
}

export interface DelegationEndEvent {
  kind: "delegation-end"
  childRunId: string
  result: string
}

export interface AnswerEvent {
  kind: "answer"
  text: string
}

export interface ErrorEvent {
  kind: "error"
  text: string
}

export interface UsageEvent {
  kind: "usage"
  iterationTokens: number
  totalTokens: number
  promptTokens: number
  completionTokens: number
  llmCalls: number
}

export interface DelegationIterationEvent {
  kind: "delegation-iteration"
  depth: number
  iteration: number
  maxIterations: number
}

export interface DelegationParallelStartEvent {
  kind: "delegation-parallel-start"
  depth: number
  taskCount: number
  goals: string[]
}

export interface DelegationParallelEndEvent {
  kind: "delegation-parallel-end"
  depth: number
  taskCount: number
  fulfilled: number
  rejected: number
}

export interface SystemPromptEvent {
  kind: "system-prompt"
  text: string
}

export interface ToolsResolvedEvent {
  kind: "tools-resolved"
  tools: Array<{ name: string; description: string; parameters?: Record<string, unknown> }>
}

export interface LlmRequestEvent {
  kind: "llm-request"
  iteration: number
  messageCount: number
  toolCount: number
  messages: Array<{ role: string; content: string | null; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; toolCallId: string | null }>
}

export interface LlmResponseEvent {
  kind: "llm-response"
  iteration: number
  durationMs: number
  content: string | null
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null
}

export interface PlannerValidationRemediatedEvent {
  kind: "planner-validation-remediated"
  diagnostics: Array<{ code: string; message: string }>
}

export interface UserInputRequestEvent {
  kind: "user-input-request"
  question: string
  options?: string[]
  sensitive?: boolean
}

export interface UserInputResponseEvent {
  kind: "user-input-response"
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
  | { type: "drop"; seq: number }
  | { type: "replace"; seq: number; event: TrajectoryEvent }
  | { type: "inject"; seq: number; event: TrajectoryEvent }
