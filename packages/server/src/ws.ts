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
import { listWebhookDrains, saveEvent } from "./db.js"

export interface WsEvent {
  type: string
  data: Record<string, unknown>
  timestamp: string
}

// ── EventBroadcaster ─────────────────────────────────────────────

export class EventBroadcaster {
  private readonly clients = new Set<WebSocket>()

  addClient(ws: WebSocket): void {
    this.clients.add(ws)
    ws.on("close", () => this.clients.delete(ws))
    ws.on("error", () => this.clients.delete(ws))

    this.send(ws, {
      type: "ws.connected",
      data: { version: "0.1.0", clients: this.clients.size },
      timestamp: new Date().toISOString(),
    })
  }

  broadcast(event: Omit<WsEvent, "timestamp">): void {
    const msg: WsEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    }
    const json = JSON.stringify(msg)

    // 1. Push to all WS clients
    for (const client of this.clients) {
      if (client.readyState === 1) {
        client.send(json)
      }
    }

    // 2. Persist to event_log (fire-and-forget)
    try {
      saveEvent(msg.type, msg.data, msg.timestamp)
    } catch { /* don't break broadcast if DB write fails */ }

    // 3. Push to webhook drains (fire-and-forget, async)
    this.pushToWebhooks(msg, json).catch(() => {})
  }

  clientCount(): number {
    return this.clients.size
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

export function addClient(ws: WebSocket): void {
  _default.addClient(ws)
}

export function broadcast(event: Omit<WsEvent, "timestamp">): void {
  _default.broadcast(event)
}

export function clientCount(): number {
  return _default.clientCount()
}
