/**
 * Freeze-window transport routes.
 */

import { EventType } from "@mia/shared-enums"
import type { FastifyInstance, FastifyRequest } from "fastify"
import {
  deleteFreezeWindow,
  FreezeWindowValidationError,
  listFreezeWindowsForTenant,
  saveAdminAudit,
  upsertFreezeWindow
} from "../adapters/persistence/sqlite.js"
import { broadcast } from "../event-broadcaster.js"

const DEFAULT_TENANT_ID = "_default"

function resolveTenant(req: FastifyRequest): string {
  const q = (req.query as Record<string, string> | undefined)?.["tenant"]
  if (q && req.session?.isAdmin) return q
  return DEFAULT_TENANT_ID
}

function audit(req: FastifyRequest, action: string, detail: Record<string, unknown>): void {
  try {
    saveAdminAudit({
      actor: req.session.upn,
      action,
      detail: JSON.stringify(detail),
      timestamp: new Date().toISOString(),
      scope_id: "freeze-windows"
    })
  } catch (error) {
    console.warn("[freeze-windows] audit_log write failed:", error instanceof Error ? error.message : error)
  }
}

export function registerFreezeWindowRoutes(app: FastifyInstance): void {
  app.get("/api/sync/freeze-windows", async (req) => {
    const tenantId = resolveTenant(req)
    const items = listFreezeWindowsForTenant(tenantId)
    return { tenantId, items }
  })

  app.post<{
    Body: { id: string; displayName: string; description: string; startsAt: string; endsAt: string }
  }>("/api/sync/freeze-windows", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    const body = req.body
    if (!body?.id) {
      reply.code(400)
      return { error: "missing id" }
    }
    const tenantId = resolveTenant(req)
    try {
      const record = upsertFreezeWindow({
        tenantId,
        id: body.id,
        displayName: body.displayName,
        description: body.description ?? "",
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        actor: req.session.upn
      })
      audit(req, "freeze_window.upserted", {
        tenantId,
        id: record.id,
        startsAt: record.startsAt,
        endsAt: record.endsAt
      })
      broadcast({
        type: EventType.FreezeWindowUpserted,
        data: {
          tenantId,
          id: record.id,
          startsAt: record.startsAt,
          endsAt: record.endsAt,
          actor: req.session.upn
        }
      })
      return record
    } catch (error) {
      if (error instanceof FreezeWindowValidationError) {
        reply.code(422)
        return { error: error.message }
      }
      reply.code(500)
      return { error: (error as Error).message }
    }
  })

  app.delete<{ Params: { id: string } }>("/api/sync/freeze-windows/:id", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    const tenantId = resolveTenant(req)
    const ok = deleteFreezeWindow(tenantId, req.params.id)
    if (!ok) {
      reply.code(404)
      return { error: `freeze_window not found: ${req.params.id}` }
    }
    audit(req, "freeze_window.deleted", { tenantId, id: req.params.id })
    broadcast({
      type: EventType.FreezeWindowDeleted,
      data: { tenantId, id: req.params.id, actor: req.session.upn }
    })
    return { ok: true }
  })
}
