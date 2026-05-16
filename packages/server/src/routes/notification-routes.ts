/**
 * F1.10 — Notification routes management.
 *
 *   GET    /api/notification-routes                 list routes for tenant
 *   POST   /api/notification-routes                 upsert (admin only)
 *   DELETE /api/notification-routes/:id             remove (admin only)
 *   GET    /api/notification-routes/log             recent delivery log (filter by status)
 *
 * The "user notification" surface in `notifications.ts` is the existing
 * in-app inbox; this file is the F1 routing-config surface and is
 * distinct.
 */

import type { FastifyInstance, FastifyRequest } from "fastify"
import {
    deleteNotificationRoute, listNotificationLog, listNotificationRoutes,
    upsertNotificationRoute,
    type NotificationChannel, type NotificationFilter,
} from "../notifications/router.js"

const DEFAULT_TENANT_ID = "_default"

function resolveTenant(req: FastifyRequest): string {
  const q = (req.query as Record<string, string> | undefined)?.["tenant"]
  if (q && req.session?.isAdmin) return q
  return DEFAULT_TENANT_ID
}

export function registerNotificationRouteRoutes(app: FastifyInstance): void {

  app.get<{ Querystring: { tenant?: string } }>(
    "/api/notification-routes",
    async (req) => listNotificationRoutes(resolveTenant(req)),
  )

  app.post<{ Body: {
    id?:        string
    eventType:  string
    filter:     NotificationFilter
    channel:    NotificationChannel
    target:     string
    enabled?:   boolean
  } }>("/api/notification-routes", async (req, reply) => {
    if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
    try {
      return upsertNotificationRoute({
        id:        req.body.id,
        tenantId:  resolveTenant(req),
        eventType: req.body.eventType,
        filter:    req.body.filter ?? {},
        channel:   req.body.channel,
        target:    req.body.target,
        enabled:   req.body.enabled !== false,
        actor:     req.session.upn,
      })
    } catch (e) {
      reply.code(400)
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  app.delete<{ Params: { id: string } }>(
    "/api/notification-routes/:id",
    async (req, reply) => {
      if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
      deleteNotificationRoute(req.params.id)
      return { ok: true }
    },
  )

  app.get<{ Querystring: { status?: "sent"|"retrying"|"dlq"|"suppressed"; limit?: string } }>(
    "/api/notification-routes/log",
    async (req) => listNotificationLog({
      status: req.query.status,
      limit:  Math.min(1000, Math.max(1, Number(req.query.limit) || 100)),
    }),
  )
}
