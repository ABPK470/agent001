/**
 * WebSocket manager — real-time event broadcasting + persistence + webhook push.
 *
 * All connected clients receive every agent event as it happens:
 * run starts, steps execute, tools fire, audit entries log.
 * This is how the dashboard stays live.
 *
 * Events are also:
 *   - Persisted to the event_log table (for replay/backfill)
 *   - Pushed to registered webhook drains (selective subscription)
 *
 * EventBroadcaster holds the client Set as instance state.
 * A default singleton is exported for convenience; create fresh
 * instances in tests to avoid shared state.
 */

import type { WebSocket } from "@fastify/websocket"
import { createHmac } from "node:crypto"
import { getRun, listWebhookDrains, saveEvent } from "./db.js"

export interface WsEvent {
  type: string
  data: Record<string, unknown>
  timestamp: string
}

/** Identity attached to a connected WebSocket client. */
export interface WsClientIdentity {
  upn: string | null
  sid: string
  isAdmin: boolean
}

/** Minimal SSE sink — Node.js raw response stream. */
export interface SseSink {
  write: (chunk: string) => boolean
  end: () => void
  on: (event: "close" | "error", listener: () => void) => void
}

// ── EventBroadcaster ─────────────────────────────────────────────

export class EventBroadcaster {
  private readonly clients = new Map<WebSocket, WsClientIdentity>()
  private readonly sseClients = new Map<symbol, { sink: SseSink; identity: WsClientIdentity }>()
  /** Tiny LRU of runId → owner. Cleared after this many entries. */
  private readonly ownerCache = new Map<string, { upn: string | null; sid: string | null }>()

  addClient(ws: WebSocket, identity: WsClientIdentity): void {
    this.clients.set(ws, identity)
    ;(ws as unknown as { _socket?: { setNoDelay?: (v: boolean) => void } })._socket?.setNoDelay?.(true)
    ws.on("close", () => this.clients.delete(ws))
    ws.on("error", () => this.clients.delete(ws))

    this.send(ws, {
      type: "ws.connected",
      data: { version: "0.1.0", clients: this.clients.size },
      timestamp: new Date().toISOString(),
    })
  }

  /**
   * Register a Server-Sent Events client. Returns a disposer that the route
   * handler must call when the underlying response closes.
   *
   * SSE is preferred for production deployments behind HTTP-only reverse
   * proxies (e.g. proxy-https on the corp Windows host) that don't forward
   * WebSocket Upgrade frames. The wire format is plain text-event-stream:
   * each event is serialised as `data: <json>\n\n`.
   */
  addSseClient(sink: SseSink, identity: WsClientIdentity): () => void {
    const key = Symbol()
    this.sseClients.set(key, { sink, identity })
    const dispose = () => { this.sseClients.delete(key) }
    sink.on("close", dispose)
    sink.on("error", dispose)
    // Initial padding + hello event
    sink.write(`: connected\n\n`)
    sink.write(`data: ${JSON.stringify({
      type: "ws.connected",
      data: { version: "0.1.0", clients: this.clientCount() },
      timestamp: new Date().toISOString(),
    })}\n\n`)
    return dispose
  }

  broadcast(event: Omit<WsEvent, "timestamp">): void {
    const msg: WsEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    }
    const json = JSON.stringify(msg)
    const sseFrame = `data: ${json}\n\n`

    // Resolve run owner once if this event is run-scoped, then send only to
    // clients that are admin OR own that run. Events without a runId go to all.
    const runId = typeof msg.data["runId"] === "string" ? (msg.data["runId"] as string) : null
    const owner = runId ? this.resolveOwner(runId) : null

    const allowed = (identity: WsClientIdentity): boolean => {
      if (!owner || identity.isAdmin) return true
      const matchesUpn = !!identity.upn && !!owner.upn && identity.upn.toLowerCase() === owner.upn.toLowerCase()
      const matchesSid = !identity.upn && !!owner.sid && owner.sid === identity.sid
      return matchesUpn || matchesSid
    }

    for (const [client, identity] of this.clients) {
      if (client.readyState !== 1) continue
      if (allowed(identity)) client.send(json)
    }

    for (const [, { sink, identity }] of this.sseClients) {
      if (allowed(identity)) {
        try { sink.write(sseFrame) } catch { /* dropped client; close handler cleans up */ }
      }
    }

    // 2. Persist to event_log (skip high-frequency ephemeral events to avoid
    //    blocking the Node.js event loop between WS frame sends)
    if (msg.type !== "answer.chunk") {
      try {
        saveEvent(msg.type, msg.data, msg.timestamp)
      } catch { /* don't break broadcast if DB write fails */ }
    }

    // 3. Push to webhook drains (fire-and-forget, async)
    this.pushToWebhooks(msg, json).catch(() => {})
  }

  /** Look up which session/upn owns a runId. Cached for perf. */
  private resolveOwner(runId: string): { upn: string | null; sid: string | null } | null {
    const hit = this.ownerCache.get(runId)
    if (hit) return hit
    const run = getRun(runId)
    if (!run) return null
    const owner = { upn: run.upn ?? null, sid: run.session_id ?? null }
    if (this.ownerCache.size > 1024) this.ownerCache.clear()
    this.ownerCache.set(runId, owner)
    return owner
  }

  clientCount(): number {
    return this.clients.size + this.sseClients.size
  }

  private send(ws: WebSocket, event: WsEvent): void {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(event))
    }
  }

  private async pushToWebhooks(event: WsEvent, json: string): Promise<void> {
    const drains = listWebhookDrains()
    if (drains.length === 0) return

    for (const drain of drains) {
      if (!drain.enabled) continue

      const filters: string[] = JSON.parse(drain.event_filters || "[]")
      if (filters.length > 0) {
        const matches = filters.some((f) => event.type === f || event.type.startsWith(f + ".") || event.type.startsWith(f))
        if (!matches) continue
      }

      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (drain.secret) {
        const sig = createHmac("sha256", drain.secret).update(json).digest("hex")
        headers["X-Agent001-Signature"] = `sha256=${sig}`
      }
      headers["X-Agent001-Event"] = event.type
      headers["X-Agent001-Drain-Id"] = drain.id

      fetch(drain.url, {
        method: "POST",
        headers,
        body: json,
        signal: AbortSignal.timeout(5000),
      }).catch(() => {})
    }
  }
}

// ── Default singleton + backward-compatible exports ──────────────

const _default = new EventBroadcaster()

export function addClient(ws: WebSocket, identity: WsClientIdentity): void {
  _default.addClient(ws, identity)
}

export function addSseClient(sink: SseSink, identity: WsClientIdentity): () => void {
  return _default.addSseClient(sink, identity)
}

export function broadcast(event: Omit<WsEvent, "timestamp">): void {
  _default.broadcast(event)
}

export function clientCount(): number {
  return _default.clientCount()
}
