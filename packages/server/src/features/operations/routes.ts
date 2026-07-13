/**
 * Operation log transport routes.
 */

import type { FastifyInstance } from "fastify"
import { subscribeToEvents } from "../../platform/events/broadcaster.js"
import { searchEvents } from "../../platform/persistence/events.js"
import {
  listOperations,
  OPERATIONS_PAGE_EVENT_LIMIT
} from "./application/query/index.js"

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

  app.get("/api/operations/stream", (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    })

    const send = (data: unknown): boolean => {
      try {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
        return true
      } catch {
        return false
      }
    }

    send({ refresh: true, at: new Date().toISOString() })

    let debounce: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = subscribeToEvents(() => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        if (!send({ refresh: true, at: new Date().toISOString() })) unsubscribe()
      }, 400)
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
