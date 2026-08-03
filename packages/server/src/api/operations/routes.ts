import { parseBoundaryJson } from "../../internal/parse-json.js"

/**
 * Operation log transport — Personal. Scope from personal.read.
 */

import type { FastifyInstance, FastifyReply } from "fastify"
import { subscribeToEvents } from "../../infra/events/broadcaster.js"
import { searchEvents } from "../../infra/persistence/events.js"
import { isOperationLogEvent } from "./service/query/operation-log-events.js"
import {
  listOperations,
  OPERATIONS_HEAD_EVENT_LIMIT,
  OPERATIONS_PAGE_EVENT_LIMIT
} from "./service/query/index.js"
import { personal, viewingAsOf } from "../auth/service/viewing-as.js"
import { eventMatchesViewingAs } from "../../infra/events/event-viewing-as.js"

/** Debounce SSE snapshots so bursty event streams do not rebuild the log continuously. */
const OPERATIONS_STREAM_DEBOUNCE_MS = 1500

type OperationsStreamFilters = {
  kind: string | undefined
  search: string | undefined
  since: string | undefined
  until: string | undefined
  viewingAsUpn: string
}

function writeOperationsSse(reply: FastifyReply, data: unknown): boolean {
  try {
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
    return true
  } catch {
    return false
  }
}

async function pushOperationsHeadSnapshot(
  reply: FastifyReply,
  filters: OperationsStreamFilters,
): Promise<boolean> {
  const snapshot = await listOperations({
    limit: OPERATIONS_HEAD_EVENT_LIMIT,
    kind: filters.kind,
    search: filters.search,
    since: filters.since,
    until: filters.until,
    viewingAsUpn: filters.viewingAsUpn,
  })
  return writeOperationsSse(reply, { ...snapshot, live: true })
}

export function registerOperationRoutes(app: FastifyInstance): void {
  app.get<{
    Querystring: {
      limit?: string
      before?: string
      since?: string
      until?: string
      search?: string
      kind?: string
      status?: string
      planId?: string
      runId?: string
    }
  }>("/api/operations", personal.read, async (req) => {
    const { viewingAsUpn } = viewingAsOf(req)
    const limit = Math.min(Number(req.query.limit) || OPERATIONS_PAGE_EVENT_LIMIT, 10_000)
    const since =
      typeof req.query.since === "string" && req.query.since.length > 0
        ? req.query.since
        : undefined
    const until =
      typeof req.query.until === "string" && req.query.until.length > 0
        ? req.query.until
        : undefined
    return await listOperations({
      limit,
      before: req.query.before,
      since,
      until,
      search: req.query.search,
      kind: req.query.kind,
      status: req.query.status,
      planId: req.query.planId,
      runId: req.query.runId,
      viewingAsUpn,
    })
  })

  app.get<{ Params: { planId: string } }>("/api/operations/plan/:planId", personal.read, async (req, reply) => {
    const { viewingAsUpn } = viewingAsOf(req)
    const result = await listOperations({ planId: req.params.planId, viewingAsUpn })
    if (result.operations.length === 0) {
      reply.code(403)
      return { error: "forbidden" }
    }
    return result
  })

  app.get<{ Params: { runId: string } }>("/api/operations/run/:runId", personal.read, async (req, reply) => {
    const { viewingAsUpn } = viewingAsOf(req)
    const result = await listOperations({ runId: req.params.runId, viewingAsUpn })
    if (result.operations.length === 0) {
      reply.code(403)
      return { error: "forbidden" }
    }
    return result
  })

  app.get<{
    Querystring: {
      kind?: string
      search?: string
      since?: string
      until?: string
      viewingAs?: string
    }
  }>("/api/operations/stream", personal.read, (req, reply) => {
    const { viewingAsUpn } = viewingAsOf(req)
    const since =
      typeof req.query.since === "string" && req.query.since.length > 0
        ? req.query.since
        : undefined
    const until =
      typeof req.query.until === "string" && req.query.until.length > 0
        ? req.query.until
        : undefined
    const filters: OperationsStreamFilters = {
      kind: req.query.kind,
      search: req.query.search,
      since,
      until,
      viewingAsUpn,
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    })

    try {
      reply.raw.write(`: connected\n\n`)
    } catch {
      return
    }

    let debounce: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = subscribeToEvents((event) => {
      if (!isOperationLogEvent(event.type)) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(async () => {
        if (!(await pushOperationsHeadSnapshot(reply, filters))) {
          unsubscribe()
          if (debounce) clearTimeout(debounce)
        }
      }, OPERATIONS_STREAM_DEBOUNCE_MS)
    })

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`: ping\n\n`)
      } catch {
        clearInterval(heartbeat)
        unsubscribe()
        if (debounce) clearTimeout(debounce)
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
      since?: string
      until?: string
    }
  }>("/api/events/search", personal.read, async (req) => {
    const { viewingAsUpn } = viewingAsOf(req)
    const q = (req.query.q ?? "").trim()
    const types = req.query.type ? req.query.type.split(",") : undefined
    const typePatterns = req.query.type_patterns ? req.query.type_patterns.split(",") : undefined
    const since = typeof req.query.since === "string" && req.query.since.length > 0
      ? req.query.since
      : undefined
    const until = typeof req.query.until === "string" && req.query.until.length > 0
      ? req.query.until
      : undefined
    if (
      q.length < 2 &&
      !types?.length &&
      !typePatterns?.length &&
      !req.query.after &&
      !req.query.before &&
      !since &&
      !until
    ) {
      return { events: [], count: 0 }
    }
    const limit = Math.min(Number(req.query.limit) || 200, 1000)
    const rows = await searchEvents(q, {
      limit,
      types,
      type_patterns: typePatterns,
      before: req.query.before,
      after: req.query.after,
      since,
      until,
    })
    const candidateEvents = rows
      .map((row) => ({
        id: row.id,
        type: row.type,
        data: parseBoundaryJson(row.data) as Record<string, unknown>,
        timestamp: row.created_at
      }))
    const visible = await Promise.all(
      candidateEvents.map(async (event) => ({
        event,
        visible: await eventMatchesViewingAs(event.data, viewingAsUpn)
      }))
    )
    const events = visible.filter(({ visible }) => visible).map(({ event }) => event)
    return { events, count: events.length }
  })
}
