/**
 * Event stream API routes — replay/backfill + webhook drain management.
 */

import type { FastifyInstance } from "fastify"
import { randomUUID } from "node:crypto"
import * as db from "../db.js"

export function registerEventRoutes(app: FastifyInstance): void {

  // ── Event replay / backfill ────────────────────────────────────

  /**
   * GET /api/events — query the persisted event stream.
   *
   * Query params:
   *   limit   — max events to return (default 200, max 1000)
   *   before  — ISO timestamp cursor (events before this time)
   *   after   — ISO timestamp cursor (events after this time)
   *   types   — comma-separated type filters (e.g. "run.,audit,step.")
   */
  app.get<{
    Querystring: { limit?: string; before?: string; after?: string; types?: string }
  }>("/api/events", async (req) => {
    const limit = Math.min(Number(req.query.limit) || 200, 1000)
    const types = req.query.types
      ? req.query.types.split(",").map((t) => t.trim()).filter(Boolean)
      : undefined

    const events = db.listEvents({
      limit,
      before: req.query.before,
      after: req.query.after,
      types,
    })

    return {
      events: events.map((e) => ({
        id: e.id,
        type: e.type,
        data: JSON.parse(e.data),
        timestamp: e.created_at,
      })),
      count: events.length,
      hasMore: events.length === limit,
    }
  })

  // ── Webhook drain CRUD ─────────────────────────────────────────

  /** List all configured webhook drains. */
  app.get("/api/webhooks/drains", async () => {
    const drains = db.listWebhookDrains()
    return drains.map((d) => ({
      id: d.id,
      url: d.url,
      hasSecret: !!d.secret,
      eventFilters: JSON.parse(d.event_filters || "[]"),
      enabled: !!d.enabled,
      createdAt: d.created_at,
      updatedAt: d.updated_at,
    }))
  })

  /** Create a new webhook drain. */
  app.post<{
    Body: { url: string; secret?: string; eventFilters?: string[]; enabled?: boolean }
  }>("/api/webhooks/drains", async (req, reply) => {
    const { url, secret, eventFilters, enabled } = req.body
    if (!url || typeof url !== "string") {
      reply.code(400)
      return { error: "url is required" }
    }

    // Validate URL format
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
      updated_at: now,
    }

    db.saveWebhookDrain(drain)
    reply.code(201)
    return {
      id: drain.id,
      url: drain.url,
      hasSecret: !!drain.secret,
      eventFilters: eventFilters ?? [],
      enabled: !!drain.enabled,
      createdAt: drain.created_at,
    }
  })

  /** Update an existing webhook drain. */
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
      try { new URL(req.body.url) } catch {
        reply.code(400)
        return { error: "Invalid URL" }
      }
    }

    const updated: db.DbWebhookDrain = {
      ...existing,
      url: req.body.url ?? existing.url,
      secret: req.body.secret ?? existing.secret,
      event_filters: req.body.eventFilters
        ? JSON.stringify(req.body.eventFilters)
        : existing.event_filters,
      enabled: req.body.enabled !== undefined ? (req.body.enabled ? 1 : 0) : existing.enabled,
      updated_at: new Date().toISOString(),
    }

    db.saveWebhookDrain(updated)
    return {
      id: updated.id,
      url: updated.url,
      hasSecret: !!updated.secret,
      eventFilters: JSON.parse(updated.event_filters),
      enabled: !!updated.enabled,
      updatedAt: updated.updated_at,
    }
  })

  /** Delete a webhook drain. */
  app.delete<{ Params: { id: string } }>("/api/webhooks/drains/:id", async (req, reply) => {
    const existing = db.getWebhookDrain(req.params.id)
    if (!existing) {
      reply.code(404)
      return { error: "Drain not found" }
    }
    db.deleteWebhookDrain(req.params.id)
    return { ok: true }
  })
}
