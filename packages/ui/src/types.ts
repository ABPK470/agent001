/**
 * Shared frontend types — mirrors the server API contract.
 */

// ── Run ──────────────────────────────────────────────────────────

export interface Run {
  id: string
  goal: string
  status: string
  answer: string | null
  stepCount: number
  error: string | null
  parentRunId: string | null
  agentId: string | null
  createdAt: string
  completedAt: string | null
  totalTokens: number
  promptTokens: number
  completionTokens: number
  llmCalls: number
}

export interface RunDetail extends Run {
  data: {
    steps: Step[]
    [key: string]: unknown
  }
  audit: AuditEntry[]
  logs: LogEntry[]
  hasCheckpoint: boolean
}

// ── Step ─────────────────────────────────────────────────────────

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

// ── Audit ────────────────────────────────────────────────────────

export interface AuditEntry {
  actor: string
  action: string
  detail: Record<string, unknown>
  timestamp: string
}

// ── Log ──────────────────────────────────────────────────────────

export interface LogEntry {
  level: string
  message: string
  timestamp: string
}

// ── Trace (rich agent execution trace) ───────────────────────────

export type TraceEntry =
  | { kind: "goal"; text: string }
  | { kind: "iteration"; current: number; max: number }
  | { kind: "thinking"; text: string }
  | { kind: "tool-call"; tool: string; argsSummary: string; argsFormatted: string }
  | { kind: "tool-result"; text: string }
  | { kind: "tool-error"; text: string }
  | { kind: "answer"; text: string }
  | { kind: "error"; text: string }
  | { kind: "usage"; iterationTokens: number; totalTokens: number; promptTokens: number; completionTokens: number; llmCalls: number }
  | { kind: "delegation-start"; goal: string; depth: number; tools: string[]; agentId?: string; agentName?: string }
  | { kind: "delegation-iteration"; depth: number; iteration: number; maxIterations: number }
  | { kind: "delegation-end"; depth: number; status: "done" | "error"; answer?: string; error?: string }
  | { kind: "delegation-parallel-start"; depth: number; taskCount: number; goals: string[] }
  | { kind: "delegation-parallel-end"; depth: number; taskCount: number; fulfilled: number; rejected: number }
  | { kind: "user-input-request"; question: string; options?: string[]; sensitive?: boolean }
  | { kind: "user-input-response"; text: string }
  // Debug/inspector entries
  | { kind: "system-prompt"; text: string }
  | { kind: "tools-resolved"; tools: Array<{ name: string; description: string; parameters?: Record<string, unknown> }> }
  | { kind: "llm-request"; iteration: number; messageCount: number; toolCount: number; messages: Array<{ role: string; content: string | null; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; toolCallId: string | null }> }
  | { kind: "llm-response"; iteration: number; durationMs: number; content: string | null; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null }

// ── Layout ───────────────────────────────────────────────────────

export interface SavedLayout {
  id: string
  name: string
  config: ViewConfig
  updatedAt: string
}

// ── Dashboard ────────────────────────────────────────────────────

export interface Widget {
  id: string
  type: WidgetType
}

export type WidgetType =
  | "agent-chat"
  | "run-status"
  | "agent-trace"
  | "agent-viz"
  | "live-logs"
  | "audit-trail"
  | "step-timeline"
  | "tool-stats"
  | "run-history"
  | "command-center"
  | "trajectory-replay"
  | "operator-env"
  | "debug-inspector"

export interface ViewConfig {
  id: string
  name: string
  widgets: Widget[]
  layouts: Record<string, LayoutItem[]>
}

export interface LayoutItem {
  i: string
  x: number
  y: number
  w: number
  h: number
  minW?: number
  minH?: number
}

// ── WebSocket events ─────────────────────────────────────────────

export interface WsEvent {
  type: string
  data: Record<string, unknown>
  timestamp: string
}

// ── Agent Definitions ────────────────────────────────────────────

export interface AgentDefinition {
  id: string
  name: string
  description: string
  systemPrompt: string
  tools: string[]
  createdAt: string
  updatedAt: string
}

export interface ToolInfo {
  name: string
  description: string
}

// ── Policy ───────────────────────────────────────────────────────

export interface PolicyRule {
  name: string
  effect: "allow" | "require_approval" | "deny"
  condition: string
  parameters: Record<string, unknown>
  createdAt: string
}

// ── Notifications ────────────────────────────────────────────────

export interface NotificationAction {
  label: string
  action: string
  data?: Record<string, unknown>
}

export interface Notification {
  id: string
  type: string       // 'run.failed' | 'run.completed' | 'approval.required' | 'run.recovered'
  title: string
  message: string
  runId: string | null
  stepId: string | null
  actions: NotificationAction[]
  read: boolean
  createdAt: string
}

// ── Rollback ─────────────────────────────────────────────────────

export interface RollbackResult {
  total: number
  compensated: number
  skipped: number
  failed: Array<{ effectId: string; target: string; reason: string }>
}

export interface RollbackPreview {
  wouldCompensate: Array<{ effectId: string; target: string; kind: string; hasSnapshot: boolean }>
  wouldSkip: Array<{ effectId: string; target: string; reason: string }>
  wouldFail: Array<{ effectId: string; target: string; reason: string }>
}
