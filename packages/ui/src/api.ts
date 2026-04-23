/**
 * API client — HTTP + WebSocket communication with the server.
 */

import type {
    AgentDefinition,
    Notification,
    PolicyRule,
    RollbackPreview,
    RollbackResult,
    Run,
    RunDetail,
    SavedLayout,
    ToolInfo,
    ViewConfig,
    WorkspaceDiff,
    WorkspaceDiffApplyResult,
} from "./types"

const BASE = ""

// ── REST API ─────────────────────────────────────────────────────

async function json<T>(path: string, opts?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...opts?.headers as Record<string, string> }
  if (opts?.body) headers["Content-Type"] = "application/json"
  const res = await fetch(`${BASE}${path}`, { ...opts, headers })
  return res.json() as Promise<T>
}

export const api = {
  // Runs
  listRuns: () => json<Run[]>("/api/runs"),
  getRun: (id: string) => json<RunDetail>(`/api/runs/${id}`),
  startRun: (goal: string, agentId?: string) =>
    json<{ runId: string }>("/api/runs", {
      method: "POST",
      body: JSON.stringify({ goal, ...(agentId ? { agentId } : {}) }),
    }),
  cancelRun: (id: string) => json<{ ok: boolean }>(`/api/runs/${id}/cancel`, {
    method: "POST",
  }),
  resumeRun: (id: string) => json<{ runId: string }>(`/api/runs/${id}/resume`, {
    method: "POST",
  }),
  rerunRun: (id: string) => json<{ runId: string }>(`/api/runs/${id}/rerun`, {
    method: "POST",
  }),
  respondToRun: (id: string, response: string) => json<{ ok: boolean }>(`/api/runs/${id}/respond`, {
    method: "POST",
    body: JSON.stringify({ response }),
  }),
  killToolCall: (runId: string, toolCallId: string, message: string) => json<{ ok: boolean }>(`/api/runs/${runId}/kill-tool`, {
    method: "POST",
    body: JSON.stringify({ toolCallId, message }),
  }),
  getActiveRuns: () => json<{ runIds: string[] }>("/api/runs/active"),
  getRunTrace: (id: string) => json<Record<string, unknown>[]>(`/api/runs/${id}/trace`),
  getRunWorkspaceDiff: (id: string) => json<WorkspaceDiff>(`/api/runs/${id}/workspace-diff`),
  applyRunWorkspaceDiff: (id: string) => json<WorkspaceDiffApplyResult>(`/api/runs/${id}/workspace-diff/apply`, {
    method: "POST",
  }),

  // Rollback
  previewRollback: (runId: string) =>
    json<RollbackPreview>(`/api/effects/${encodeURIComponent(runId)}/rollback-preview`),
  rollbackRun: (runId: string) =>
    json<RollbackResult>(`/api/effects/${encodeURIComponent(runId)}/rollback`, {
      method: "POST",
    }),

  // Layouts
  listLayouts: () => json<SavedLayout[]>("/api/layouts"),
  saveLayout: (name: string, config: ViewConfig) =>
    json<{ id: string }>("/api/layouts", {
      method: "POST",
      body: JSON.stringify({ name, config }),
    }),
  deleteLayout: (id: string) => json<{ ok: boolean }>(`/api/layouts/${id}`, {
    method: "DELETE",
  }),

  // Dashboard state (auto-save)
  getDashboardState: () => json<{ views: ViewConfig[]; activeViewId: string } | null>("/api/dashboard-state"),
  saveDashboardState: (state: { views: ViewConfig[]; activeViewId: string }) =>
    json<{ ok: boolean }>("/api/dashboard-state", {
      method: "PUT",
      body: JSON.stringify(state),
    }),

  // Health
  health: () => json<{ status: string, active: number }>("/api/health"),

  // Usage
  getUsage: () => json<{
    totals: { promptTokens: number; completionTokens: number; totalTokens: number; llmCalls: number; runCount: number; completedRuns: number; failedRuns: number }
    runs: Array<{ runId: string; promptTokens: number; completionTokens: number; totalTokens: number; llmCalls: number; model: string; createdAt: string }>
  }>("/api/usage"),

  // Policies
  listPolicies: () => json<PolicyRule[]>("/api/policies"),
  createPolicy: (rule: { name: string; effect: string; condition: string; parameters?: Record<string, unknown> }) =>
    json<{ ok: boolean }>("/api/policies", {
      method: "POST",
      body: JSON.stringify(rule),
    }),
  deletePolicy: (name: string) =>
    json<{ ok: boolean }>(`/api/policies/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),

  // Data management
  resetData: () => json<{ ok: boolean }>("/api/data", { method: "DELETE" }),

  // Workspace
  getWorkspace: () => json<{ path: string }>("/api/workspace"),
  setWorkspace: (path: string) =>
    json<{ ok: boolean; path: string }>("/api/workspace", {
      method: "PUT",
      body: JSON.stringify({ path }),
    }),

  // LLM config
  getLlmConfig: () =>
    json<{
      provider: string
      model: string
      hasApiKey: boolean
      baseUrl: string
      updatedAt: string
      defaults: Record<string, { model: string; baseUrl: string; placeholder: string }>
    }>("/api/llm"),
  setLlmConfig: (cfg: { provider: string; model?: string; apiKey?: string; baseUrl?: string }) =>
    json<{ ok: boolean; provider: string; model: string }>("/api/llm", {
      method: "PUT",
      body: JSON.stringify(cfg),
    }),

  // Tools
  listTools: () => json<ToolInfo[]>("/api/tools"),

  // Agents
  listAgents: () => json<AgentDefinition[]>("/api/agents"),
  getAgent: (id: string) => json<AgentDefinition>(`/api/agents/${encodeURIComponent(id)}`),
  createAgent: (agent: { name: string; description?: string; systemPrompt: string; tools: string[] }) =>
    json<AgentDefinition>("/api/agents", {
      method: "POST",
      body: JSON.stringify(agent),
    }),
  updateAgent: (id: string, agent: Partial<{ name: string; description: string; systemPrompt: string; tools: string[] }>) =>
    json<AgentDefinition>(`/api/agents/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(agent),
    }),
  deleteAgent: (id: string) =>
    json<{ ok: boolean }>(`/api/agents/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  // Notifications
  listNotifications: (limit = 50) => json<Notification[]>(`/api/notifications?limit=${limit}`),
  getUnreadCount: () => json<{ count: number }>("/api/notifications/unread-count"),
  markNotificationRead: (id: string) => json<{ ok: boolean }>(`/api/notifications/${id}/read`, { method: "POST" }),
  markAllNotificationsRead: () => json<{ ok: boolean }>("/api/notifications/read-all", { method: "POST" }),
  executeNotificationAction: (id: string, action: string, data?: Record<string, unknown>) =>
    json<{ ok: boolean; runId?: string }>(`/api/notifications/${id}/action`, {
      method: "POST",
      body: JSON.stringify({ action, data }),
    }),

  // Trajectory
  getTrajectory: (runId: string) =>
    json<{ runId: string; events: Array<{ seq: number; event: Record<string, unknown>; timestamp: string }> }>(
      `/api/trajectory/${encodeURIComponent(runId)}`,
    ),
  replayTrajectory: (runId: string, mutations?: Array<Record<string, unknown>>) =>
    json<{
      valid: boolean
      violations: Array<{ seq: number; from: string; to: string; message: string }>
      scorecard: Record<string, unknown>
      eventCount: number
    }>(`/api/trajectory/${encodeURIComponent(runId)}/replay`, {
      method: "POST",
      body: JSON.stringify({ mutations }),
    }),
  compareTrajectories: (runIdA: string, runIdB: string) =>
    json<{
      sameGoal: boolean
      goalSimilarity: number
      toolOverlap: number
      toolCallDelta: number
      iterationDelta: number
      errorRateDelta: number
      moreEfficient: "a" | "b" | "equal"
      outcomeA: "answer" | "error" | "incomplete"
      outcomeB: "answer" | "error" | "incomplete"
      summary: string
    }>("/api/trajectory/compare", {
      method: "POST",
      body: JSON.stringify({ runIdA, runIdB }),
    }),
  getTrajectorySummary: (runId: string) =>
    json<{ summary: string }>(`/api/trajectory/${encodeURIComponent(runId)}/summary`),

  // Mymi DB explorer
  mymiListDatabases: () =>
    json<Array<{ name: string; server: string; database: string; writeEnabled: boolean }>>("/api/mymi/databases"),
  mymiOverview: (db?: string) =>
    json<Array<{ schema: string; tableCount: number; viewCount: number; totalRows: number; totalMb: number }>>(
      `/api/mymi/overview${db ? `?db=${encodeURIComponent(db)}` : ""}`,
    ),
  mymiListSchemas: (db?: string) =>
    json<Array<{ name: string; tableCount: number; viewCount: number }>>(
      `/api/mymi/schemas${db ? `?db=${encodeURIComponent(db)}` : ""}`,
    ),
  mymiSearch: (q: string, db?: string, schemas?: string[]) =>
    json<Array<{
      schema: string; name: string; type: "table" | "view"
      rowCount: number; matchKind: "object" | "column"
      columnName: string | null; columnType: string | null
    }>>(
      `/api/mymi/search?q=${encodeURIComponent(q)}${db ? `&db=${encodeURIComponent(db)}` : ""}${schemas?.length ? `&schemas=${schemas.map(encodeURIComponent).join(",")}` : ""}`,
    ),
  mymiListObjects: (schema: string, db?: string) =>
    json<Array<{ name: string; type: "table" | "view"; rowCount: number; sizeMb: number; columnCount: number }>>(
      `/api/mymi/schema/${encodeURIComponent(schema)}${db ? `?db=${encodeURIComponent(db)}` : ""}`,
    ),
  mymiColumns: (schema: string, table: string, db?: string) =>
    json<Array<{
      ordinal: number; name: string; dataType: string; typeDetail: string | null
      nullable: boolean; identity: boolean; computed: boolean; isPk: boolean
      fkSchema: string | null; fkTable: string | null; fkColumn: string | null
      description: string | null
    }>>(
      `/api/mymi/schema/${encodeURIComponent(schema)}/table/${encodeURIComponent(table)}/columns${db ? `?db=${encodeURIComponent(db)}` : ""}`,
    ),
  mymiRelations: (schema: string, table: string, db?: string) =>
    json<{
      outbound: Array<{ constraintName: string; localColumn: string; refSchema: string; refTable: string; refColumn: string; refRowCount: number }>
      inbound:  Array<{ constraintName: string; srcSchema: string; srcTable: string; srcColumn: string; localColumn: string; srcRowCount: number }>
    }>(
      `/api/mymi/schema/${encodeURIComponent(schema)}/table/${encodeURIComponent(table)}/relations${db ? `?db=${encodeURIComponent(db)}` : ""}`,
    ),
  mymiPreview: (schema: string, table: string, db?: string, limit?: number) =>
    json<{ columns: Array<{ name: string; type: string }>; rows: Record<string, unknown>[] }>(
      `/api/mymi/schema/${encodeURIComponent(schema)}/table/${encodeURIComponent(table)}/preview?${new URLSearchParams({ ...(db ? { db } : {}), ...(limit ? { limit: String(limit) } : {}) }).toString()}`,
    ),
  mymiLineage: (schema: string, table: string, db?: string) =>
    json<Record<string, unknown>>(
      `/api/mymi/schema/${encodeURIComponent(schema)}/table/${encodeURIComponent(table)}/lineage${db ? `?db=${encodeURIComponent(db)}` : ""}`,
    ),
  mymiDataModel: (db?: string) =>
    json<{
      objects: Array<{ schema: string; name: string; isTable: boolean; rowCount: number; sizeMb: number; columnCount: number; fkOut: number; fkIn: number }>
      relations: Array<{ srcSchema: string; srcTable: string; refSchema: string; refTable: string }>
    }>(`/api/mymi/datamodel${db ? `?db=${encodeURIComponent(db)}` : ""}`),
}

// ── WebSocket + cross-tab relay via BroadcastChannel ─────────────

const BC_CHANNEL = "agent001-ws-relay"

export function createWs(
  onEvent: (event: { type: string, data: Record<string, unknown>, timestamp: string }) => void,
  onStatus: (connected: boolean) => void,
): { close: () => void } {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  const url = `${protocol}//${window.location.host}/ws`

  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let alive = true

  // Deduplicate events across WS + BroadcastChannel
  const seen = new Set<string>()
  function eventKey(e: { type: string; timestamp: string; data: Record<string, unknown> }): string {
    // debug.trace events need entry-level uniqueness (kind + seq) since
    // multiple entries can share the same timestamp + runId
    const seq = e.data["seq"] ?? ""
    const kind = e.type === "debug.trace" ? ((e.data["entry"] as Record<string, unknown>)?.["kind"] ?? "") : ""
    return `${e.type}:${e.timestamp}:${e.data["runId"] ?? ""}:${e.data["stepId"] ?? ""}:${kind}:${seq}`
  }
  function dedupe(event: { type: string; data: Record<string, unknown>; timestamp: string }): boolean {
    const key = eventKey(event)
    if (seen.has(key)) return false
    seen.add(key)
    // Keep set bounded
    if (seen.size > 500) {
      const it = seen.values()
      for (let i = 0; i < 250; i++) it.next()
      // Rebuild with recent half
      const arr = [...seen].slice(-250)
      seen.clear()
      arr.forEach((k) => seen.add(k))
    }
    return true
  }

  // Cross-tab relay: share WS events between all windows
  const bc = new BroadcastChannel(BC_CHANNEL)
  bc.onmessage = (e) => {
    try {
      if (dedupe(e.data)) onEvent(e.data)
    } catch { /* ignore */ }
  }

  function connect() {
    if (!alive) return
    ws = new WebSocket(url)

    ws.onopen = () => onStatus(true)

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data as string)
        if (dedupe(event)) {
          onEvent(event)
          // Relay to other tabs/windows
          bc.postMessage(event)
        }
      } catch { /* ignore malformed messages */ }
    }

    ws.onclose = () => {
      onStatus(false)
      if (alive) {
        reconnectTimer = setTimeout(connect, 2000)
      }
    }

    ws.onerror = () => ws?.close()
  }

  connect()

  return {
    close() {
      alive = false
      bc.close()
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ws?.close()
    },
  }
}
