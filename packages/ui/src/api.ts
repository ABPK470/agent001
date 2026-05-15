/**
 * API client — HTTP + SSE communication with the server.
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
    SyncEntityType,
    SyncEnvironment,
    SyncExecuteProgress,
    SyncPlan,
    SyncRecipeBundle,
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
  // credentials: include — sends the session cookie cross-port (UI on 5173, server on 3102 in dev).
  const res = await fetch(`${BASE}${path}`, { ...opts, headers, credentials: "include" })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const msg = body && typeof body === "object" && "error" in body ? (body as { error: string }).error : `HTTP ${res.status}`
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

export const api = {
  // Runs
  listRuns: (opts?: { scope?: "session" | "all" }) =>
    json<Run[]>(`/api/runs${opts?.scope ? `?scope=${opts.scope}` : ""}`),
  getRun: (id: string) => json<RunDetail>(`/api/runs/${id}`),
  startRun: (goal: string, agentId?: string, attachmentIds?: string[]) =>
    json<{ runId: string; attachmentIds?: string[] }>("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        goal,
        ...(agentId ? { agentId } : {}),
        ...(attachmentIds && attachmentIds.length > 0 ? { attachmentIds } : {}),
      }),
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

  // Sync-environment overrides (admin)
  listSyncEnvironments: () => json<import("./types").SyncEnvironmentAdmin[]>("/api/sync-environments"),
  updateSyncEnvironment: (name: string, fields: Record<string, unknown>) =>
    json<{ ok: boolean }>(`/api/sync-environments/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify(fields),
    }),
  resetSyncEnvironment: (name: string) =>
    json<{ ok: boolean }>(`/api/sync-environments/${encodeURIComponent(name)}`, {
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

  // ── ABI Environment Sync ────────────────────────────────────
  syncEnvironments: () => json<SyncEnvironment[]>("/api/sync/environments"),
  syncRecipes: () => json<SyncRecipeBundle>("/api/sync/recipes"),
  syncSearch: (params: { entityType: SyncEntityType; source: string; q: string; limit?: number }) =>
    json<Array<{ id: string | number; name: string | null }>>(
      `/api/sync/search?entityType=${encodeURIComponent(params.entityType)}&source=${encodeURIComponent(params.source)}&q=${encodeURIComponent(params.q)}${params.limit ? `&limit=${params.limit}` : ""}`,
    ),
  syncPreview: (params: { entityType: SyncEntityType; entityId: string | number; source: string; target: string; force?: boolean; enabledOptionalTables?: string[] }) =>
    json<SyncPlan & { error?: string }>("/api/sync/preview", { method: "POST", body: JSON.stringify(params) }),
  syncPlan: (planId: string) => json<SyncPlan & { error?: string }>(`/api/sync/plan/${encodeURIComponent(planId)}`),
  syncExecute: (planId: string) =>
    json<{ planId: string; success: boolean; error?: string }>(
      `/api/sync/execute/${encodeURIComponent(planId)}`,
      { method: "POST" },
    ),
  syncHistory: (limit = 100) =>
    json<Array<{ planId: string; actor: string; action: string; detail: unknown; timestamp: string }>>(
      `/api/sync/history?limit=${limit}`,
    ),
  /** Recent sync execution runs — used to restore the EnvSync widget on cold start. */
  syncRuns: (limit = 25) =>
    json<Array<{
      planId: string
      entityType: string
      entityId: string
      entityDisplayName: string | null
      source: string
      target: string
      actorUpn: string | null
      status: "started" | "success" | "failed"
      error: string | null
      startedAt: string
      finishedAt: string | null
      durationMs: number | null
    }>>(`/api/sync/runs?limit=${limit}`),

  /**
   * Recent persisted events from the unified `event_log` table.
   * Used on cold start to backfill the LiveLogs widget so prior sync /
   * agent / system events survive a server restart.
   */
  recentEvents: (limit = 500) =>
    json<{ events: Array<{ id: number; type: string; data: Record<string, unknown>; timestamp: string }>; count: number; hasMore: boolean }>(
      `/api/events?limit=${limit}`,
    ),

  /** Full-text search of the persistent event_log table. Used by LiveLogs DB-fallback. */
  searchEvents: (q: string, opts: { types?: string[]; limit?: number; before?: string; after?: string } = {}) => {
    const p = new URLSearchParams({ q })
    if (opts.types?.length) p.set("type", opts.types.join(","))
    if (opts.limit) p.set("limit", String(opts.limit))
    if (opts.before) p.set("before", opts.before)
    if (opts.after) p.set("after", opts.after)
    return json<{ events: Array<{ id: number; type: string; data: Record<string, unknown>; timestamp: string }>; count: number }>(
      `/api/events/search?${p.toString()}`,
    )
  },

  /**
   * Operation Log — three-level grouped history of pipelines → activities → events.
   * Server bundles related events into pipelines (agent runs, sync previews,
   * sync executes, system minute-buckets) so the UI can render an expandable
   * tree.
   */
  operations: (opts: { limit?: number; before?: string; search?: string; kind?: string; status?: string } = {}) => {
    const params = new URLSearchParams()
    if (opts.limit != null) params.set("limit", String(opts.limit))
    if (opts.before) params.set("before", opts.before)
    if (opts.search) params.set("search", opts.search)
    if (opts.kind) params.set("kind", opts.kind)
    if (opts.status) params.set("status", opts.status)
    const qs = params.toString()
    return json<OperationsResponse>(`/api/operations${qs ? `?${qs}` : ""}`)
  },

  // ── Attachments ────────────────────────────────────────────────
  /**
   * Upload a single file as an attachment. Returns the persisted metadata
   * including the new attachment id; pass that id to startRun() via
   * attachmentIds to bind it to the run.
   *
   * The body is JSON+base64 because the server uses the matching JSON
   * route (no multipart plugin). The `FileReader` calls are isolated
   * here so callers never touch raw bytes.
   */
  uploadAttachment: async (file: File, opts?: {
    scope?: "session" | "run" | "workspace_asset"
    runId?: string
    purposeTag?: string
  }): Promise<UploadedAttachment> => {
    const contentBase64 = await fileToBase64(file)
    return json<UploadedAttachment>("/api/attachments", {
      method: "POST",
      body: JSON.stringify({
        name:          file.name,
        mediaType:     file.type || "application/octet-stream",
        contentBase64,
        scope:         opts?.scope ?? "session",
        ...(opts?.runId      ? { runId:      opts.runId }      : {}),
        ...(opts?.purposeTag ? { purposeTag: opts.purposeTag } : {}),
      }),
    })
  },

  listAttachments: (filter?: { scope?: string; runId?: string; q?: string }) => {
    const params = new URLSearchParams()
    if (filter?.scope) params.set("scope", filter.scope)
    if (filter?.runId) params.set("runId", filter.runId)
    if (filter?.q)     params.set("q",     filter.q)
    const qs = params.toString()
    return json<UploadedAttachment[]>(`/api/attachments${qs ? `?${qs}` : ""}`)
  },

  deleteAttachment: (id: string) =>
    json<{ ok: boolean }>(`/api/attachments/${id}`, { method: "DELETE" }),
}

export interface UploadedAttachment {
  id:             string
  scope:          "run" | "session" | "workspace_asset"
  originalName:   string
  normalizedName: string
  mediaType:      string
  sizeBytes:      number
  contentHash:    string
  ingestionMode:  "text_inline" | "text_retrieval" | "binary_reference" | "provider_file_api"
  uploadedAt:     string
  purposeTag:     string | null
}

/**
 * Read a browser File into a base64 string. Strips the data: URL prefix
 * the FileReader emits so the result matches what the server expects in
 * `contentBase64`.
 */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"))
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== "string") {
        reject(new Error("unexpected reader result"))
        return
      }
      const comma = result.indexOf(",")
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.readAsDataURL(file)
  })
}

export { OperationKind, OperationStatus } from "@mia/shared-enums"

export interface OperationEvent {
  type: string
  timestamp: string
  data: Record<string, unknown>
}
export interface OperationActivity {
  id: string
  name: string
  status: OperationStatus
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  summary?: string
  error?: string
  events: OperationEvent[]
}
export interface OperationPipeline {
  id: string
  kind: OperationKind
  title: string
  subtitle?: string
  status: OperationStatus
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  activityCount: number
  eventCount: number
  error?: string
  activities: OperationActivity[]
}
export interface OperationsResponse {
  operations: OperationPipeline[]
  scannedEvents: number
  oldestTimestamp: string | null
}

/**
 * Open an SSE stream for a sync execution. Returns a `close()` function.
 * `onEvent` is called for each progress event (started → table-* → completed/failed).
 */
export function syncExecuteStream(
  planId: string,
  onEvent: (e: SyncExecuteProgress) => void,
  onError?: (err: string) => void,
): { close: () => void } {
  const es = new EventSource(`/api/sync/execute/${encodeURIComponent(planId)}/stream`, { withCredentials: true })
  es.onmessage = (msg) => {
    try { onEvent(JSON.parse(msg.data) as SyncExecuteProgress) }
    catch (e) { onError?.(e instanceof Error ? e.message : String(e)) }
  }
  es.onerror = () => {
    onError?.("SSE connection error")
    es.close()
  }
  return { close: () => es.close() }
}

// ── Live event stream + cross-tab relay via BroadcastChannel ─────
//
// Transport: Server-Sent Events (HTTP streaming). Works through any HTTP
// reverse proxy without HTTP upgrade support — including the corp
// proxy-https on the Windows host. Auto-reconnects via the browser's
// EventSource implementation.

const BC_CHANNEL = "mia-ws-relay"

export function createEventStream(
  onEvent: (event: { type: string, data: Record<string, unknown>, timestamp: string }) => void,
  onStatus: (connected: boolean) => void,
): { close: () => void } {
  const url = `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/events/stream`

  let es: EventSource | null = null
  let alive = true

  // Deduplicate events across stream + BroadcastChannel
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
    if (seen.size > 500) {
      const arr = [...seen].slice(-250)
      seen.clear()
      arr.forEach((k) => seen.add(k))
    }
    return true
  }

  // Cross-tab relay: share events between all windows
  const bc = new BroadcastChannel(BC_CHANNEL)
  bc.onmessage = (e) => {
    try {
      if (dedupe(e.data)) onEvent(e.data)
    } catch { /* ignore */ }
  }

  function connect() {
    if (!alive) return
    es = new EventSource(url, { withCredentials: true })

    es.onopen = () => onStatus(true)

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data as string)
        if (dedupe(event)) {
          onEvent(event)
          bc.postMessage(event)
        }
      } catch { /* ignore malformed messages */ }
    }

    es.onerror = () => {
      onStatus(false)
      // EventSource auto-reconnects; nothing else to do unless we've torn down.
      if (!alive) es?.close()
    }
  }

  connect()

  return {
    close() {
      alive = false
      bc.close()
      es?.close()
    },
  }
}

/**
 * Pop-out window event relay — listens via BroadcastChannel only (no SSE).
 * Avoids duplicate connections and prevents SSE replays from clearing live state.
 */
export function createPopoutEventRelay(
  onEvent: (event: { type: string; data: Record<string, unknown>; timestamp: string }) => void,
  onStatus: (connected: boolean) => void,
): { close: () => void } {
  const bc = new BroadcastChannel(BC_CHANNEL)
  onStatus(true) // assume connected — main window manages the SSE
  bc.onmessage = (e) => {
    try { onEvent(e.data) } catch { /* ignore */ }
  }
  return { close: () => bc.close() }
}
