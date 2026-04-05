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
 */

import type { WebSocket } from "@fastify/websocket"
import { createHmac } from "node:crypto"

export interface WsEvent {
  type: string
  data: Record<string, unknown>
  timestamp: string
}

const clients = new Set<WebSocket>()

// ── Lazy imports (avoid circular dep with db.ts) ─────────────────

let _saveEvent: ((type: string, data: Record<string, unknown>, ts: string) => void) | null = null
let _listWebhookDrains: (() => Array<{ id: string; url: string; secret: string; event_filters: string; enabled: number }>) | null = null

async function loadDbFns(): Promise<void> {
  if (_saveEvent) return
  const db = await import("./db.js")
  _saveEvent = db.saveEvent
  _listWebhookDrains = db.listWebhookDrains
}

// Kick off immediately (non-blocking)
loadDbFns().catch(() => {})

export function addClient(ws: WebSocket): void {
  clients.add(ws)
  ws.on("close", () => clients.delete(ws))
  ws.on("error", () => clients.delete(ws))

  // Welcome message
  send(ws, {
    type: "ws.connected",
    data: { version: "0.1.0", clients: clients.size },
    timestamp: new Date().toISOString(),
  })
}

export function broadcast(event: Omit<WsEvent, "timestamp">): void {
  const msg: WsEvent = {
    ...event,
    timestamp: new Date().toISOString(),
  }
  const json = JSON.stringify(msg)

  // 1. Push to all WS clients
  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(json)
    }
  }

  // 2. Persist to event_log (fire-and-forget)
  try {
    _saveEvent?.(msg.type, msg.data, msg.timestamp)
  } catch { /* don't break broadcast if DB write fails */ }

  // 3. Push to webhook drains (fire-and-forget, async)
  pushToWebhooks(msg, json).catch(() => {})
}

export function clientCount(): number {
  return clients.size
}

function send(ws: WebSocket, event: WsEvent): void {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(event))
  }
}

// ── Webhook push delivery ────────────────────────────────────────

async function pushToWebhooks(event: WsEvent, json: string): Promise<void> {
  if (!_listWebhookDrains) return
  const drains = _listWebhookDrains()
  if (drains.length === 0) return

  for (const drain of drains) {
    if (!drain.enabled) continue

    // Check selective subscription filters
    const filters: string[] = JSON.parse(drain.event_filters || "[]")
    if (filters.length > 0) {
      const matches = filters.some((f) => event.type === f || event.type.startsWith(f + ".") || event.type.startsWith(f))
      if (!matches) continue
    }

    // Build signature for verification
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (drain.secret) {
      const sig = createHmac("sha256", drain.secret).update(json).digest("hex")
      headers["X-Agent001-Signature"] = `sha256=${sig}`
    }
    headers["X-Agent001-Event"] = event.type
    headers["X-Agent001-Drain-Id"] = drain.id

    // Non-blocking POST
    fetch(drain.url, {
      method: "POST",
      headers,
      body: json,
      signal: AbortSignal.timeout(5000),
    }).catch(() => {
      // Silently drop delivery failures — don't slow the event bus
    })
  }
}
