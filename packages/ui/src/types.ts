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
  createdAt: string
  completedAt: string | null
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
  | "live-logs"
  | "audit-trail"
  | "step-timeline"
  | "tool-stats"
  | "run-history"

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
