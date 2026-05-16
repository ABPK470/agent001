/**
 * Freeze-window admin routes.
 *
 *   GET    /api/sync/freeze-windows                  list (tenant-scoped)
 *   POST   /api/sync/freeze-windows                  upsert (admin)
 *   DELETE /api/sync/freeze-windows/:id              delete (admin)
 *
 * Mutations also push the updated set into the agent's in-process
 * registry so the sync gate sees the new state without a server restart.
 * Every mutation writes an audit_log entry under run_id `__admin__`.
 */

import type { FastifyInstance, FastifyRequest } from "fastify"
import { getDb } from "../db/connection.js"
import {
    deleteFreezeWindow,
    FreezeWindowValidationError,
    listFreezeWindowsForTenant,
    upsertFreezeWindow,
} from "../db/freeze-windows.js"

const DEFAULT_TENANT_ID = "_default"
const ADMIN_RUN_ID      = "__admin__"

function resolveTenant(req: FastifyRequest): string {
  const q = (req.query as Record<string, string> | undefined)?.["tenant"]
  if (q && req.session?.isAdmin) return q
  return DEFAULT_TENANT_ID
}

function audit(req: FastifyRequest, action: string, detail: Record<string, unknown>): void {
  try {
    getDb().prepare(
      `INSERT INTO audit_log (run_id, actor, action, detail, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      ADMIN_RUN_ID,
      req.session?.upn ?? "unknown",
      action,
      JSON.stringify(detail),
      new Date().toISOString(),
    )
  } catch (e) {
    console.warn("[freeze-windows] audit_log write failed:", e instanceof Error ? e.message : e)
  }
}

export function registerFreezeWindowRoutes(app: FastifyInstance): void {
  app.get("/api/sync/freeze-windows", async (req) => {
    const tenantId = resolveTenant(req)
    const items = listFreezeWindowsForTenant(tenantId)
    return { tenantId, items }
  })

  app.post<{ Body: { id: string; displayName: string; description: string; startsAt: string; endsAt: string } }>(
    "/api/sync/freeze-windows",
    async (req, reply) => {
      if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
      const b = req.body
      if (!b?.id) { reply.code(400); return { error: "missing id" } }
      const tenantId = resolveTenant(req)
      try {
        const rec = upsertFreezeWindow({
          tenantId,
          id:          b.id,
          displayName: b.displayName,
          description: b.description ?? "",
          startsAt:    b.startsAt,
          endsAt:      b.endsAt,
          actor:       req.session.upn,
        })
        audit(req, "freeze_window.upserted", { tenantId, id: rec.id, startsAt: rec.startsAt, endsAt: rec.endsAt })
        return rec
      } catch (e) {
        if (e instanceof FreezeWindowValidationError) {
          reply.code(422); return { error: e.message }
        }
        reply.code(500); return { error: (e as Error).message }
      }
    },
  )

  app.delete<{ Params: { id: string } }>(
    "/api/sync/freeze-windows/:id",
    async (req, reply) => {
      if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
      const tenantId = resolveTenant(req)
      const ok = deleteFreezeWindow(tenantId, req.params.id)
      if (!ok) { reply.code(404); return { error: `freeze_window not found: ${req.params.id}` } }
      audit(req, "freeze_window.deleted", { tenantId, id: req.params.id })
      return { ok: true }
    },
  )
}
