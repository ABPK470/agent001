/**
 * Slim type contract — only what term UI actually renders.
 * Mirrors `packages/ui/src/types.ts` for the subset we use.
 */

export interface Run {
  id: string
  goal: string
  status: string
  answer: string | null
  stepCount: number
  error: string | null
  createdAt: string
  completedAt: string | null
  totalTokens: number
  promptTokens: number
  completionTokens: number
  llmCalls: number
  /** Current agent iteration (live — updated by delegation.iteration events). */
  lastIteration?: number
  /** Max iterations allowed for this run (live). */
  maxIterations?: number
  /** Whether the planner was used (a plan was introduced). */
  usedPlanner?: boolean
}

export interface RunDetail extends Run {
  data: { steps: Step[]; [k: string]: unknown }
  audit: AuditEntry[]
  logs: LogEntry[]
}

export interface Step {
  id: string
  name: string
  action: string
  status: string
  order: number
  input: Record<string, unknown>
  output: Record<string, unknown>
  error: string | null
  startedAt: string | null
  completedAt: string | null
}

export interface AuditEntry {
  actor: string
  action: string
  detail: Record<string, unknown>
  timestamp: string
}

export interface LogEntry {
  type: string
  error?: boolean
  message: string
  timestamp: string
  eventName?: string
  data?: Record<string, unknown>
}

export interface Me {
  sessionId: string
  displayName: string
  upn: string | null
  isAdmin: boolean
}

/** Raw SSE event envelope — what `/api/events/stream` emits. */
export interface SseEvent {
  type: string
  data: Record<string, unknown>
  timestamp: string
}
