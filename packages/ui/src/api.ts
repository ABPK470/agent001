/**
 * API client — HTTP + WebSocket communication with the server.
 */

import type { Run, RunDetail, SavedLayout, ViewConfig } from "./types"

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
  startRun: (goal: string) => json<{ runId: string }>("/api/runs", {
    method: "POST",
    body: JSON.stringify({ goal }),
  }),
  cancelRun: (id: string) => json<{ ok: boolean }>(`/api/runs/${id}/cancel`, {
    method: "POST",
  }),
  resumeRun: (id: string) => json<{ runId: string }>(`/api/runs/${id}/resume`, {
    method: "POST",
  }),
  getActiveRuns: () => json<{ runIds: string[] }>("/api/runs/active"),

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

  // Health
  health: () => json<{ status: string, active: number }>("/api/health"),
}

// ── WebSocket ────────────────────────────────────────────────────

export function createWs(
  onEvent: (event: { type: string, data: Record<string, unknown>, timestamp: string }) => void,
  onStatus: (connected: boolean) => void,
): { close: () => void } {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  const url = `${protocol}//${window.location.host}/ws`

  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let alive = true

  function connect() {
    if (!alive) return
    ws = new WebSocket(url)

    ws.onopen = () => onStatus(true)

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data as string)
        onEvent(event)
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
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ws?.close()
    },
  }
}
