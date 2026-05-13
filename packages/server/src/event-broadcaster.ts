/**
 * Real-time event broadcaster.
 *
 * Single transport: Server-Sent Events. Wire format `data: <json>\n\n` over a
 * long-lived HTTP response held open by `GET /api/events/stream`. The browser's
 * native `EventSource` API handles connection, reconnect, and parsing.
 *
 * Every `broadcast()` call:
 *   1. Stamps a timestamp + serialises once.
 *   2. Resolves the originating run's owner (`runId` field on the event)
 *      and fans out only to clients that own the run or are admin.
 *      Non-run-scoped events go to every connected client.
 *   3. Persists to the `event_log` SQLite table (skipping high-frequency
 *      `answer.chunk` events) so disconnected clients can replay history
 *      and webhook drains have a durable source.
 *   4. Pushes to registered HMAC-signed webhook drains (filtered by
 *      event-type prefix).
 *
 * `EventBroadcaster` holds client state as instance fields. A default
 * singleton is exported via the module-level helpers; tests should construct
 * fresh instances to avoid shared state.
 *
 * Backend-internal event flow (agent → server) does NOT use this transport.
 * It uses in-process callback injection (`setSyncEventSink`,
 * `engineServices` listeners, `onProgress`) which the server then forwards
 * here via `broadcast(...)`.
 */

import { createHmac } from "node:crypto"
import { getRun, listWebhookDrains, saveEvent } from "./db.js"

export interface SseEvent {
  type: string
  data: Record<string, unknown>
  timestamp: string
}

/** Identity attached to a connected SSE client. */
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
  private readonly sseClients = new Map<symbol, { sink: SseSink; identity: WsClientIdentity }>()
  /** Internal subscribers — notified after every broadcast() call. */
  private readonly subscribers = new Set<(event: SseEvent) => void>()
  /** Tiny LRU of runId → owner. Cleared after this many entries. */
  private readonly ownerCache = new Map<string, { upn: string | null; sid: string | null }>()

  /**
   * Register an SSE client. Returns a disposer that the route handler must
   * call when the underlying response closes.
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
      type: "events.connected",
      data: { version: "0.1.0", clients: this.clientCount() },
      timestamp: new Date().toISOString(),
    })}\n\n`)
    return dispose
  }

  broadcast(event: Omit<SseEvent, "timestamp">): void {
    const msg: SseEvent = {
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
      // Sid match was previously gated on `!identity.upn`. That gate caused
      // the chat-stuck-on-Thinking bug: a client whose SSE socket was opened
      // pre-welcome (identity.upn=null) and later got a new cookie (new sid
      // + upn) could never receive run events again — matchesUpn was false
      // (server-side identity still had upn=null) AND matchesSid was false
      // (sid mismatch). Sids are per-cookie unique, so matching by sid is
      // safe regardless of whether the client also carries a UPN.
      const matchesSid = !!owner.sid && !!identity.sid && owner.sid === identity.sid
      return matchesUpn || matchesSid
    }

    for (const [, { sink, identity }] of this.sseClients) {
      if (allowed(identity)) {
        try { sink.write(sseFrame) } catch { /* dropped client; close handler cleans up */ }
      }
    }

    // Persist to event_log (skip high-frequency ephemeral events to keep
    // the table compact and avoid blocking between SSE writes).
    if (msg.type !== "answer.chunk" && msg.type !== "stream.reset") {
      try {
        saveEvent(msg.type, msg.data, msg.timestamp)
      } catch { /* don't break broadcast if DB write fails */ }
    }

    // Push to webhook drains (fire-and-forget, async)
    this.pushToWebhooks(msg, json).catch(() => {})
    // Notify internal subscribers
    for (const fn of this.subscribers) {
      try { fn(msg) } catch { /* ignore */ }
    }
  }

  /**
   * Subscribe to every broadcast event. Returns an unsubscribe function.
   * Used by internal SSE endpoints (e.g. /api/operations/stream) that need
   * to react to events without being a real client.
   */
  subscribe(fn: (event: SseEvent) => void): () => void {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
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
    return this.sseClients.size
  }

  private async pushToWebhooks(event: SseEvent, json: string): Promise<void> {
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

// ── Default singleton + module-level helpers ─────────────────────

const _default = new EventBroadcaster()

export function addSseClient(sink: SseSink, identity: WsClientIdentity): () => void {
  return _default.addSseClient(sink, identity)
}

export function broadcast(event: Omit<SseEvent, "timestamp">): void {
  _default.broadcast(event)
}

export function clientCount(): number {
  return _default.clientCount()
}

export function subscribeToEvents(fn: (event: SseEvent) => void): () => void {
  return _default.subscribe(fn)
}
