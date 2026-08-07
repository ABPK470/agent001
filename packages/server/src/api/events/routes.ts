import { parseBoundaryJson } from "../../internal/parse-json.js"

/**
 * Event transport — /api/events is Personal; webhook drains are Platform.
 */

import type { FastifyInstance } from "fastify"
import { randomUUID } from "node:crypto"
import * as db from "../../infra/persistence/sqlite.js"
import { admin } from "../auth/service/require-admin.js"
import { canAccessOwned, personal, viewingAsOf } from "../auth/service/viewing-as.js"
import { eventMatchesViewingAs } from "../../infra/events/event-viewing-as.js"
import { buildEventHistogram } from "./service/histogram.js"

export function registerEventRoutes(app: FastifyInstance): void {
  app.get<{
    Querystring: {
      since?: string
      until?: string
      buckets?: string
      q?: string
      exclude_types?: string
      type_patterns?: string
      errors_only?: string
    }
  }>("/api/events/histogram", personal.read, async (req, reply) => {
    const since = typeof req.query.since === "string" ? req.query.since : ""
    const until = typeof req.query.until === "string" ? req.query.until : ""
    if (!since || !until) {
      reply.code(400)
      return { error: "since and until are required" }
    }
    const bucketCount = Math.min(96, Math.max(1, Number(req.query.buckets) || 48))
    const excludeTypes = req.query.exclude_types
      ? req.query.exclude_types.split(",").map((t) => t.trim()).filter(Boolean)
      : undefined
    const typePatterns = req.query.type_patterns
      ? req.query.type_patterns.split(",").map((t) => t.trim()).filter(Boolean)
      : undefined
    const { viewingAsUpn } = viewingAsOf(req)
    return buildEventHistogram({
      since,
      until,
      bucketCount,
      viewingAsUpn,
      excludeTypes,
      typePatterns,
      q: typeof req.query.q === "string" ? req.query.q : undefined,
      errorsOnly: req.query.errors_only === "1" || req.query.errors_only === "true",
    })
  })

  app.get<{
    Querystring: {
      limit?: string
      before?: string
      after?: string
      since?: string
      until?: string
      types?: string
      exclude_types?: string
    }
  }>("/api/events", personal.read, async (req) => {
    const { viewingAsUpn } = viewingAsOf(req)
    // Event Stream: cursor pages of surface events (exclude debug.trace by default
    // from the client). Cap keeps a single page cheap; scroll loads older.
    // Over-fetch then filter to Viewing as so pages still fill reasonably.
    const limit = Math.min(Number(req.query.limit) || 200, 2000)
    const types = req.query.types
      ? req.query.types
          .split(",")
          .map((type) => type.trim())
          .filter(Boolean)
      : undefined
    const excludeTypes = req.query.exclude_types
      ? req.query.exclude_types
          .split(",")
          .map((type) => type.trim())
          .filter(Boolean)
      : undefined
    const since = typeof req.query.since === "string" && req.query.since.length > 0
      ? req.query.since
      : undefined
    const until = typeof req.query.until === "string" && req.query.until.length > 0
      ? req.query.until
      : undefined

    const rows = await db.listEvents({
      limit: Math.min(limit * 3, 6000),
      before: req.query.before,
      after: req.query.after,
      since,
      until,
      types,
      excludeTypes
    })

    const candidateEvents = rows
      .map((event) => ({
        id: event.id,
        type: event.type,
        data: parseBoundaryJson(event.data) as Record<string, unknown>,
        timestamp: event.created_at
      }))
    const visible = await Promise.all(
      candidateEvents.map(async (event) => ({
        event,
        visible: await eventMatchesViewingAs(event.data, viewingAsUpn)
      }))
    )
    const events = visible.filter(({ visible }) => visible).map(({ event }) => event).slice(0, limit)

    // Newest-first from DB; oldestTimestamp is the cursor for the next older page.
    const oldestTimestamp = events.length > 0 ? events[events.length - 1]!.timestamp : null
    const newestTimestamp = events.length > 0 ? events[0]!.timestamp : null

    return {
      events,
      count: events.length,
      oldestTimestamp,
      newestTimestamp,
      hasMore: events.length >= limit
    }
  })

  app.get("/api/webhooks/drains", admin, async () => {
    const drains = await db.listWebhookDrains()
    return drains.map((drain) => ({
      id: drain.id,
      url: drain.url,
      hasSecret: !!drain.secret,
      eventFilters: parseBoundaryJson(drain.event_filters || "[]"),
      enabled: !!drain.enabled,
      createdAt: drain.created_at,
      updatedAt: drain.updated_at
    }))
  })

  app.post<{ Body: { url: string; secret?: string; eventFilters?: string[]; enabled?: boolean } }>(
    "/api/webhooks/drains",
    admin,
    async (req, reply) => {
      const { url, secret, eventFilters, enabled } = req.body
      if (!url || typeof url !== "string") {
        reply.code(400)
        return { error: "url is required" }
      }

      try {
        new URL(url)
      } catch {
        reply.code(400)
        return { error: "Invalid URL" }
      }

      const now = new Date().toISOString()
      const drain: db.DbWebhookDrain = {
        id: randomUUID(),
        url,
        secret: secret ?? "",
        event_filters: JSON.stringify(eventFilters ?? []),
        enabled: (enabled ?? true) ? 1 : 0,
        created_at: now,
        updated_at: now
      }

      await db.saveWebhookDrain(drain)
      reply.code(201)
      return {
        id: drain.id,
        url: drain.url,
        hasSecret: !!drain.secret,
        eventFilters: eventFilters ?? [],
        enabled: !!drain.enabled,
        createdAt: drain.created_at
      }
    }
  )

  app.put<{
    Params: { id: string }
    Body: { url?: string; secret?: string; eventFilters?: string[]; enabled?: boolean }
  }>("/api/webhooks/drains/:id", { ...admin }, async (req, reply) => {
    const existing = await db.getWebhookDrain(req.params.id)
    if (!existing) {
      reply.code(404)
      return { error: "Drain not found" }
    }

    if (req.body.url) {
      try {
        new URL(req.body.url)
      } catch {
        reply.code(400)
        return { error: "Invalid URL" }
      }
    }

    const updated: db.DbWebhookDrain = {
      ...existing,
      url: req.body.url ?? existing.url,
      secret: req.body.secret ?? existing.secret,
      event_filters: req.body.eventFilters ? JSON.stringify(req.body.eventFilters) : existing.event_filters,
      enabled: req.body.enabled !== undefined ? (req.body.enabled ? 1 : 0) : existing.enabled,
      updated_at: new Date().toISOString()
    }

    await db.saveWebhookDrain(updated)
    return {
      id: updated.id,
      url: updated.url,
      hasSecret: !!updated.secret,
      eventFilters: parseBoundaryJson(updated.event_filters),
      enabled: !!updated.enabled,
      updatedAt: updated.updated_at
    }
  })

  app.delete<{ Params: { id: string } }>("/api/webhooks/drains/:id", admin, async (req, reply) => {
    const existing = await db.getWebhookDrain(req.params.id)
    if (!existing) {
      reply.code(404)
      return { error: "Drain not found" }
    }
    await db.deleteWebhookDrain(req.params.id)
    return { ok: true }
  })

  app.get<{ Params: { id: string } }>("/api/events/sql/:id", personal.read, async (req, reply) => {
    const viewingAs = viewingAsOf(req)
    const id = Number(req.params.id)
    if (!Number.isFinite(id) || id <= 0) {
      reply.code(400)
      return { error: "invalid sql log id" }
    }
    const row = await db.getSyncSqlLog(id)
    if (!row) {
      reply.code(404)
      return { error: "sql log not found" }
    }
    const planId = row.plan_id
    if (!planId) {
      reply.code(403)
      return { error: "forbidden" }
    }
    const syncRun = await db.getSyncRun(planId)
    if (!canAccessOwned(viewingAs, syncRun?.actor_upn)) {
      reply.code(403)
      return { error: "forbidden" }
    }
    return {
      id: row.id,
      planId: row.plan_id,
      previewId: row.preview_id,
      eventType: row.event_type,
      scope: row.scope,
      label: row.label,
      connection: row.connection,
      sql: row.sql_text,
      sqlLength: row.sql_text.length,
      durationMs: row.duration_ms,
      rowCount: row.row_count,
      error: row.error,
      createdAt: row.created_at,
    }
  })
}
