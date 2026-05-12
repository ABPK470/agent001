/**
 * Operation Log API — three-level grouped history.
 *
 * GET /api/operations?limit=N&before=ISO
 * GET /api/operations/stream  — SSE; pushes updated snapshots on every event
 *
 * Returns the most-recent operations grouped as pipelines → activities → events.
 * See operations.ts for the grouping rules.
 */

import type { FastifyInstance } from "fastify";
import { searchEvents } from "../db/events.js";
import { subscribeToEvents } from "../event-broadcaster.js";
import { listOperations } from "../operations.js";

export function registerOperationRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { limit?: string; before?: string; search?: string; kind?: string; status?: string } }>("/api/operations", async (req) => {
    const limit = Math.min(Number(req.query.limit) || 1000, 5000)
    const before = req.query.before
    const search = req.query.search
    const kind = req.query.kind
    const status = req.query.status
    return listOperations({ limit, before, search, kind, status })
  })

  /** SSE stream — pushes a fresh operations snapshot on every event broadcast (debounced 400ms). */
  app.get("/api/operations/stream", (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    })

    const send = (data: unknown): boolean => {
      try { reply.raw.write(`data: ${JSON.stringify(data)}\n\n`); return true }
      catch { return false }
    }

    // Initial snapshot (most recent 500 operations)
    send(listOperations({ limit: 500 }))

    let debounce: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = subscribeToEvents(() => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        if (!send(listOperations({ limit: 500 }))) unsubscribe()
      }, 400)
    })

    const heartbeat = setInterval(() => {
      try { reply.raw.write(`: ping\n\n`) }
      catch { clearInterval(heartbeat); unsubscribe() }
    }, 25_000)

    req.raw.on("close", () => {
      clearInterval(heartbeat)
      if (debounce) clearTimeout(debounce)
      unsubscribe()
    })
  })

  /** Full-text search of raw event_log rows. Used by LiveLogs DB fallback. */
  app.get<{ Querystring: { q: string; type?: string; type_patterns?: string; limit?: string; before?: string; after?: string } }>("/api/events/search", async (req) => {
    const q = (req.query.q ?? "").trim()
    const types = req.query.type ? req.query.type.split(",") : undefined
    const type_patterns = req.query.type_patterns ? req.query.type_patterns.split(",") : undefined
    // Require at least one filter condition — text, types, type patterns, or a time bound.
    // A time-bounded query with no other filter is valid (hist mode "show all in last N days").
    if (q.length < 2 && !types?.length && !type_patterns?.length && !req.query.after && !req.query.before) {
      return { events: [], count: 0 }
    }
    const limit = Math.min(Number(req.query.limit) || 200, 1000)
    const rows = searchEvents(q, { limit, types, type_patterns, before: req.query.before, after: req.query.after })
    const events = rows.map((r) => ({
      id: r.id,
      type: r.type,
      data: JSON.parse(r.data) as Record<string, unknown>,
      timestamp: r.created_at,
    }))
    return { events, count: events.length }
  })
}
