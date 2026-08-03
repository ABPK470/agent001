/**
 * Real-time event broadcaster.
 *
 * Single transport: Server-Sent Events. Wire format `data: <json>\n\n` over a
 * long-lived HTTP response held open by `GET /api/events/stream`. The browser's
 * native `EventSource` API handles connection, reconnect, and parsing.
 *
 * Every `broadcast()` call:
 *   1. Stamps a timestamp + serialises once.
 *   2. Fans out with `eventMatchesViewingAs` — same Personal visibility
 *      dialect as historical `/api/events` (unknown owner → all; known
 *      mismatch → drop).
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
 * It uses in-process callback injection (`configureSyncEventSink`,
 * `engineServices` listeners, `onProgress`) which the server then forwards
 * here via `broadcast(...)`.
 */

import { EventType } from "@mia/shared-enums"
import type { SseEvent, TraceEntry } from "@mia/shared-types"
import { createHmac } from "node:crypto"
import { registerSseBroadcastSink } from "./emit.js"
import { eventMatchesViewingAsLive } from "./event-viewing-as.js"
import { enrichEventDataWithOwner } from "../../ports/run-owner-index.js"
import { toDurableEvent } from "../../ports/event-store.js"
import { getEventStore, listWebhookDrains } from "../persistence/sqlite.js"

export type { SseEvent }

/** Identity attached to a connected SSE client. */
export interface WsClientIdentity {
  /** Signed-in session UPN. */
  upn: string | null
  sid: string
  isAdmin: boolean
  /** Personal data owner for this connection (Viewing as). Defaults to upn. */
  viewingAsUpn: string | null
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

  /**
   * Register an SSE client. Returns a disposer that the route handler must
   * call when the underlying response closes.
   */
  addSseClient(sink: SseSink, identity: WsClientIdentity): () => void {
    const key = Symbol()
    this.sseClients.set(key, { sink, identity })
    const dispose = () => {
      this.sseClients.delete(key)
    }
    sink.on("close", dispose)
    sink.on("error", dispose)
    // Initial padding + hello event
    sink.write(`: connected\n\n`)
    sink.write(
      `data: ${JSON.stringify({
        type: EventType.EventsConnected,
        data: { version: "0.1.0", clients: this.clientCount() },
        timestamp: new Date().toISOString()
      })}\n\n`
    )
    return dispose
  }

  broadcast(event: Omit<SseEvent, "timestamp">): void {
    const data = enrichEventDataWithOwner(event.data ?? {})
    const msg: SseEvent = {
      ...event,
      data,
      timestamp: new Date().toISOString()
    }
    const json = JSON.stringify(msg)
    const sseFrame = `data: ${json}\n\n`

    for (const [, { sink, identity }] of this.sseClients) {
      const viewingAs = identity.viewingAsUpn ?? identity.upn
      if (!viewingAs || !eventMatchesViewingAsLive(msg.data, viewingAs)) continue
      try {
        sink.write(sseFrame)
      } catch (err: unknown) { console.error("[mia]", err) }
    }

    // Persist off the SSE stack (EventStore queues + batched flush).
    if (
      msg.type !== EventType.AnswerChunk &&
      msg.type !== EventType.StreamReset &&
      msg.type !== EventType.SessionPresenceTick
    ) {
      getEventStore().append(toDurableEvent(msg.type, msg.data, msg.timestamp))
    }

    // Push to webhook drains (fire-and-forget, async)
    this.pushToWebhooks(msg, json).catch((err: unknown) => { console.error("[mia]", err) })
    // Notify internal subscribers
    for (const fn of this.subscribers) {
      try {
        fn(msg)
      } catch (err: unknown) { console.error("[mia]", err) }
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

  clientCount(): number {
    return this.sseClients.size
  }

  private async pushToWebhooks(event: SseEvent, json: string): Promise<void> {
    const drains = await listWebhookDrains()
    if (drains.length === 0) return

    for (const drain of drains) {
      if (!drain.enabled) continue

      const filters: string[] = JSON.parse(drain.event_filters || "[]")
      if (filters.length > 0) {
        const matches = filters.some(
          (f) => event.type === f || event.type.startsWith(f + ".") || event.type.startsWith(f)
        )
        if (!matches) continue
      }

      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (drain.secret) {
        const sig = createHmac("sha256", drain.secret).update(json).digest("hex")
        headers["X-Mia-Signature"] = `sha256=${sig}`
      }
      headers["X-Mia-Event"] = event.type
      headers["X-Mia-Drain-Id"] = drain.id

      fetch(drain.url, {
        method: "POST",
        headers,
        body: json,
        signal: AbortSignal.timeout(5000)
      }).catch((err: unknown) => { console.error("[mia]", err) })
    }
  }
}

// ── Default singleton + module-level helpers ─────────────────────

const _default = new EventBroadcaster()

registerSseBroadcastSink((event) => _default.broadcast(event))

export function addSseClient(sink: SseSink, identity: WsClientIdentity): () => void {
  return _default.addSseClient(sink, identity)
}

export function broadcast(event: Omit<SseEvent, "timestamp">): void {
  _default.broadcast(event)
}

/**
 * Adapter for SSE wire format — widens a typed event payload (e.g.
 * `DomainEvent`, audit/api-request entries) into the loosely-indexed
 * `Record<string, unknown>` that `SseEvent.data` exposes for the
 * downstream JSON serializer. Centralizes the single unavoidable
 * structural-widening cast so call sites do not sprinkle
 * `as unknown as Record<string, unknown>`.
 */
export function toBroadcastData<T extends object>(value: T): Record<string, unknown> {
  return value as unknown as Record<string, unknown>
}

export function clientCount(): number {
  return _default.clientCount()
}

export function subscribeToEvents(fn: (event: SseEvent) => void): () => void {
  return _default.subscribe(fn)
}

/**
 * Typed convenience wrapper for the canonical `EventType.DebugTrace`
 * envelope. The wire shape `{ runId, seq, entry }` is fixed; the
 * `entry` discriminator (`TraceEntry["kind"]`) is the contract every
 * UI trace renderer narrows on. Centralising the wrapper here means
 * adding a new trace kind requires updating `TraceEntry` in
 * `@mia/shared-types` first — every call site then either narrows or
 * fails compilation.
 */
export function broadcastTrace(runId: string, seq: number, entry: TraceEntry): void {
  _default.broadcast({
    type: EventType.DebugTrace,
    data: { runId, seq, entry }
  })
}

/**
 * Permissive trace broadcaster — for forwarding trace shapes that are
 * structurally compatible with `TraceEntry` but reach this boundary
 * with a wider declared type (e.g. `Record<string, unknown>` from the
 * agent's `onChildTrace` callback or `unknown` planner-trace entries
 * dispatched in `planner-events.ts`).
 *
 * Centralizes the single structural-narrowing cast so the 4 forwarders
 * do not each carry their own `as TraceEntry` and so that any future
 * tightening (e.g. runtime kind validation against `TraceEntry["kind"]`)
 * can be added in one place.
 */
export function broadcastTraceLoose(
  runId: string,
  seq: number,
  entry: { kind: string } & Record<string, unknown>
): void {
  _default.broadcast({
    type: EventType.DebugTrace,
    data: { runId, seq, entry: entry as unknown as TraceEntry }
  })
}
