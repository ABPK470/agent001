/**
 * API client — HTTP + WebSocket communication with the server.
 */

import type { AgentDefinition, PolicyRule, Run, RunDetail, SavedLayout, ToolInfo, ViewConfig } from "./types"

const BASE = ""

// ── REST API ─────────────────────────────────────────────────────

async function json<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...opts?.headers },
  })
  return res.json() as Promise<T>
}

export const api = {
  // Runs
  listRuns: () => json<Run[]>("/api/runs"),
  getRun: (id: string) => json<RunDetail>(`/api/runs/${id}`),
  startRun: (goal: string, agentId?: string) => json<{ runId: string }>("/api/runs", {
    method: "POST",
    body: JSON.stringify(agentId ? { goal, agentId } : { goal }),
  }),
  cancelRun: (id: string) => json<{ ok: boolean }>(`/api/runs/${id}/cancel`, {
    method: "POST",
  }),
  resumeRun: (id: string) => json<{ runId: string }>(`/api/runs/${id}/resume`, {
    method: "POST",
  }),
  getActiveRuns: () => json<{ runIds: string[] }>("/api/runs/active"),
  getRunTrace: (id: string) => json<Record<string, unknown>[]>(`/api/runs/${id}/trace`),

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
    totals: { promptTokens: number; completionTokens: number; totalTokens: number; llmCalls: number; runCount: number }
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
    return `${e.type}:${e.timestamp}:${e.data["runId"] ?? ""}:${e.data["stepId"] ?? ""}`
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
