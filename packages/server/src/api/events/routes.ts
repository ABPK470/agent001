/**
 * Event stream transport routes.
 */

import type { FastifyInstance } from "fastify"
import { randomUUID } from "node:crypto"
import * as db from "../../infra/persistence/sqlite.js"

export function registerEventRoutes(app: FastifyInstance): void {
  app.get<{
    Querystring: {
      limit?: string
      before?: string
      after?: string
      types?: string
      exclude_types?: string
    }
  }>("/api/events", async (req) => {
    // Event Stream hydrate asks for ~2k surface events; debug.trace is excluded
    // via exclude_types so the window is not all loop noise.
    const limit = Math.min(Number(req.query.limit) || 200, 5000)
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

    const events = db.listEvents({
      limit,
      before: req.query.before,
      after: req.query.after,
      types,
      excludeTypes
    })

    return {
      events: events.map((event) => ({
        id: event.id,
        type: event.type,
        data: JSON.parse(event.data),
        timestamp: event.created_at
      })),
      count: events.length,
      hasMore: events.length === limit
    }
  })

  app.get("/api/webhooks/drains", async () => {
    const drains = db.listWebhookDrains()
    return drains.map((drain) => ({
      id: drain.id,
      url: drain.url,
      hasSecret: !!drain.secret,
      eventFilters: JSON.parse(drain.event_filters || "[]"),
      enabled: !!drain.enabled,
      createdAt: drain.created_at,
      updatedAt: drain.updated_at
    }))
  })

  app.post<{ Body: { url: string; secret?: string; eventFilters?: string[]; enabled?: boolean } }>(
    "/api/webhooks/drains",
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

      db.saveWebhookDrain(drain)
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
  }>("/api/webhooks/drains/:id", async (req, reply) => {
    const existing = db.getWebhookDrain(req.params.id)
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

    db.saveWebhookDrain(updated)
    return {
      id: updated.id,
      url: updated.url,
      hasSecret: !!updated.secret,
      eventFilters: JSON.parse(updated.event_filters),
      enabled: !!updated.enabled,
      updatedAt: updated.updated_at
    }
  })

  app.delete<{ Params: { id: string } }>("/api/webhooks/drains/:id", async (req, reply) => {
    const existing = db.getWebhookDrain(req.params.id)
    if (!existing) {
      reply.code(404)
      return { error: "Drain not found" }
    }
    db.deleteWebhookDrain(req.params.id)
    return { ok: true }
  })

  app.get<{ Params: { id: string } }>("/api/events/sql/:id", async (req, reply) => {
    const id = Number(req.params.id)
    if (!Number.isFinite(id) || id <= 0) {
      reply.code(400)
      return { error: "invalid sql log id" }
    }
    const row = db.getSyncSqlLog(id)
    if (!row) {
      reply.code(404)
      return { error: "sql log not found" }
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
