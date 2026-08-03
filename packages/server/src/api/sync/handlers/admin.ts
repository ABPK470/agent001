/**
 * Freeze-window transport routes.
 */

import { EventType } from "@mia/shared-enums"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { broadcast } from "../../../infra/events/broadcaster.js"
import {
  deleteFreezeWindow,
  FreezeWindowValidationError,
  getFreezeWindow,
  listFreezeWindowsForTenant,
  saveAdminAudit,
  upsertFreezeWindow
} from "../../../infra/persistence/sqlite.js"
import { withBeforeAfter } from "../../admin/audit-detail.js"

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
    const items = await listFreezeWindowsForTenant(tenantId)
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
      const prior = await getFreezeWindow(tenantId, body.id)
      const record = await upsertFreezeWindow({
        tenantId,
        id: body.id,
        displayName: body.displayName,
        description: body.description ?? "",
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        actor: req.session.upn
      })
      audit(
        req,
        "freeze_window.upserted",
        withBeforeAfter(
          {
            tenantId,
            id: record.id,
            startsAt: record.startsAt,
            endsAt: record.endsAt,
          },
          prior,
          record,
        ),
      )
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
    const prior = await getFreezeWindow(tenantId, req.params.id)
    const ok = await deleteFreezeWindow(tenantId, req.params.id)
    if (!ok) {
      reply.code(404)
      return { error: `freeze_window not found: ${req.params.id}` }
    }
    audit(
      req,
      "freeze_window.deleted",
      withBeforeAfter({ tenantId, id: req.params.id }, prior, null),
    )
    broadcast({
      type: EventType.FreezeWindowDeleted,
      data: { tenantId, id: req.params.id, actor: req.session.upn }
    })
    return { ok: true }
  })
}
