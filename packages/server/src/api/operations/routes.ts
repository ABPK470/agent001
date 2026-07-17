/**
 * Operation log transport routes.
 */

import type { FastifyInstance } from "fastify"
import { subscribeToEvents } from "../../infra/events/broadcaster.js"
import { searchEvents } from "../../infra/persistence/events.js"
import { isOperationLogEvent } from "./application/query/operation-log-events.js"
import {
  listOperations,
  OPERATIONS_HEAD_EVENT_LIMIT,
  OPERATIONS_PAGE_EVENT_LIMIT
} from "./application/query/index.js"

/** Debounce SSE snapshots so bursty event streams do not rebuild the log continuously. */
const OPERATIONS_STREAM_DEBOUNCE_MS = 1500

export function registerOperationRoutes(app: FastifyInstance): void {
  app.get<{
    Querystring: {
      limit?: string
      before?: string
      search?: string
      kind?: string
      status?: string
      planId?: string
      runId?: string
    }
  }>("/api/operations", async (req) => {
    const limit = Math.min(Number(req.query.limit) || OPERATIONS_PAGE_EVENT_LIMIT, 10_000)
    return listOperations({
      limit,
      before: req.query.before,
      search: req.query.search,
      kind: req.query.kind,
      status: req.query.status,
      planId: req.query.planId,
      runId: req.query.runId
    })
  })

  app.get<{ Params: { planId: string } }>("/api/operations/plan/:planId", async (req) => {
    return listOperations({ planId: req.params.planId })
  })

  app.get<{ Params: { runId: string } }>("/api/operations/run/:runId", async (req) => {
    return listOperations({ runId: req.params.runId })
  })

  app.get<{
    Querystring: { kind?: string; search?: string }
  }>("/api/operations/stream", (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    })

    const streamFilters = {
      kind: req.query.kind,
      search: req.query.search
    }

    const send = (data: unknown): boolean => {
      try {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
        return true
      } catch {
        return false
      }
    }

    // Connected comment only — the client loads via REST; SSE pushes debounced head snapshots.
    try {
      reply.raw.write(`: connected\n\n`)
    } catch {
      return
    }

    let debounce: ReturnType<typeof setTimeout> | null = null
    const pushHeadSnapshot = (): void => {
      const snapshot = listOperations({
        limit: OPERATIONS_HEAD_EVENT_LIMIT,
        kind: streamFilters.kind,
        search: streamFilters.search
      })
      if (!send({ ...snapshot, live: true })) unsubscribe()
    }

    const unsubscribe = subscribeToEvents((event) => {
      if (!isOperationLogEvent(event.type)) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(pushHeadSnapshot, OPERATIONS_STREAM_DEBOUNCE_MS)
    })

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`: ping\n\n`)
      } catch {
        clearInterval(heartbeat)
        unsubscribe()
      }
    }, 25_000)

    req.raw.on("close", () => {
      clearInterval(heartbeat)
      if (debounce) clearTimeout(debounce)
      unsubscribe()
    })
  })

  app.get<{
    Querystring: {
      q: string
      type?: string
      type_patterns?: string
      limit?: string
      before?: string
      after?: string
    }
  }>("/api/events/search", async (req) => {
    const q = (req.query.q ?? "").trim()
    const types = req.query.type ? req.query.type.split(",") : undefined
    const typePatterns = req.query.type_patterns ? req.query.type_patterns.split(",") : undefined
    if (q.length < 2 && !types?.length && !typePatterns?.length && !req.query.after && !req.query.before) {
      return { events: [], count: 0 }
    }
    const limit = Math.min(Number(req.query.limit) || 200, 1000)
    const rows = searchEvents(q, {
      limit,
      types,
      type_patterns: typePatterns,
      before: req.query.before,
      after: req.query.after
    })
    const events = rows.map((row) => ({
      id: row.id,
      type: row.type,
      data: JSON.parse(row.data) as Record<string, unknown>,
      timestamp: row.created_at
    }))
    return { events, count: events.length }
  })
}
