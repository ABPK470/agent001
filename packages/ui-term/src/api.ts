/**
 * Slim API client + SSE stream for the term UI.
 *
 * Same backend, same wire contract as the classic UI — we just don't
 * import the kitchen-sink (force-graphs, layouts, sync-recipes, …).
 */

import type { Me, Run, RunDetail, SseEvent } from "./types"

const BASE = ""

async function json<T>(path: string, opts?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(opts?.headers as Record<string, string>) }
  if (opts?.body) headers["Content-Type"] = "application/json"
  const res = await fetch(`${BASE}${path}`, { ...opts, headers, credentials: "include" })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const msg = body && typeof body === "object" && "error" in body
      ? (body as { error: string }).error
      : `HTTP ${res.status}`
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

export const api = {
  // identity
  me:           () => json<Me>("/api/me"),
  setMe:        (displayName: string, upn: string) =>
    json<Me>("/api/me", { method: "POST", body: JSON.stringify({ displayName, upn }) }),
  clearMe:      () => json<{ ok: boolean }>("/api/me/clear", { method: "POST" }),

  // runs
  listRuns:     () => json<Run[]>("/api/runs"),
  getRun:       (id: string) => json<RunDetail>(`/api/runs/${id}`),
  startRun:     (goal: string, agentId?: string) =>
    json<{ runId: string }>("/api/runs", {
      method: "POST",
      body: JSON.stringify({ goal, ...(agentId ? { agentId } : {}) }),
    }),
  cancelRun:    (id: string) => json<{ ok: boolean }>(`/api/runs/${id}/cancel`, { method: "POST" }),
  rerunRun:     (id: string) => json<{ runId: string }>(`/api/runs/${id}/rerun`, { method: "POST" }),
  respondToRun: (id: string, response: string) =>
    json<{ ok: boolean }>(`/api/runs/${id}/respond`, {
      method: "POST",
      body: JSON.stringify({ response }),
    }),

  // rollback — reverts effects (filesystem changes, db writes, etc.) of a finished run
  previewRollback: (runId: string) =>
    json<{ effects?: Array<{ kind: string; target: string }>; effectCount?: number }>(
      `/api/effects/${encodeURIComponent(runId)}/rollback-preview`,
    ),
  rollbackRun:    (runId: string) =>
    json<{ ok: boolean; reverted?: number }>(
      `/api/effects/${encodeURIComponent(runId)}/rollback`,
      { method: "POST" },
    ),

  // trace export
  getRunTrace:  (id: string) => json<Record<string, unknown>[]>(`/api/runs/${id}/trace`).catch(() => [] as Record<string, unknown>[]),

  // answer quality feedback
  flagAnswer:   (id: string, note?: string) =>
    json<{ ok: boolean; action: string }>(`/api/runs/${id}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ useful: false, note }),
    }).catch(() => ({ ok: false, action: "error" })),

  // event log — full-text search over the persistent event_log (entire history in DB)
  searchEvents: (q: string, opts?: { type?: string; type_patterns?: string[]; limit?: number; after?: string; before?: string }) => {
    const params = new URLSearchParams({ q })
    if (opts?.type)                  params.set("type", opts.type)
    if (opts?.type_patterns?.length) params.set("type_patterns", opts.type_patterns.join(","))
    if (opts?.limit)                 params.set("limit", String(opts.limit))
    if (opts?.after)                 params.set("after", opts.after)
    if (opts?.before)                params.set("before", opts.before)
    return json<{ events: SseEvent[]; count: number }>(`/api/events/search?${params}`)
      .catch(() => ({ events: [] as SseEvent[], count: 0 }))
  },
}

// ── SSE event stream ────────────────────────────────────────────

/**
 * Open the long-lived SSE stream and pipe envelopes through `onEvent`.
 * Browser auto-reconnects; we only need to surface connected/disconnected.
 */
export function createEventStream(
  onEvent: (e: SseEvent) => void,
  onStatus: (connected: boolean) => void,
): { close: () => void } {
  const url = `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/events/stream`

  let alive = true
  let es: EventSource | null = null

  const seen = new Set<string>()
  function key(e: SseEvent): string {
    const seq = e.data["seq"] ?? ""
    const kind = e.type === "debug.trace"
      ? ((e.data["entry"] as Record<string, unknown> | undefined)?.["kind"] ?? "")
      : ""
    return `${e.type}:${e.timestamp}:${e.data["runId"] ?? ""}:${e.data["stepId"] ?? ""}:${kind}:${seq}`
  }

  function dedupe(e: SseEvent): boolean {
    const k = key(e)
    if (seen.has(k)) return false
    seen.add(k)
    if (seen.size > 600) {
      const arr = [...seen].slice(-300)
      seen.clear()
      arr.forEach((x) => seen.add(x))
    }
    return true
  }

  function connect() {
    if (!alive) return
    es = new EventSource(url, { withCredentials: true })
    es.onopen = () => onStatus(true)
    es.onmessage = (ev) => {
      try {
        const env = JSON.parse(ev.data as string) as SseEvent
        if (dedupe(env)) onEvent(env)
      } catch { /* ignore malformed */ }
    }
    es.onerror = () => {
      onStatus(false)
      if (!alive) es?.close()
    }
  }

  connect()

  return {
    close() {
      alive = false
      es?.close()
    },
  }
}
