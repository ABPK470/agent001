/**
 * Notification API routes.
 */

import type { FastifyInstance } from "fastify"
import { canAccessRun } from "../auth/access.js"
import * as db from "../db/index.js"
import type { AgentOrchestrator } from "../orchestrator/index.js"

/** Returns true if the request's session may see/mutate this notification. */
function canSee(session: { isAdmin?: boolean; upn?: string | null; sid?: string } | undefined,
                n: { run_id: string | null }): boolean {
  if (session?.isAdmin) return true
  if (!n.run_id) return true
  const run = db.getRun(n.run_id)
  return canAccessRun(session as never, run ?? null)
}

export function registerNotificationRoutes(
  app: FastifyInstance,
  orchestrator: AgentOrchestrator,
): void {

  // List notifications (filtered for non-admins)
  app.get<{ Querystring: { limit?: string } }>("/api/notifications", async (req) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200)
    const s = req.session
    const notifications = s?.isAdmin
      ? db.listNotifications(limit)
      : db.listNotificationsForUser({ upn: s?.upn ?? null, sid: s?.sid ?? null }, limit)
    return notifications.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      message: n.message,
      runId: n.run_id,
      stepId: n.step_id,
      actions: JSON.parse(n.actions),
      read: n.read === 1,
      createdAt: n.created_at,
    }))
  })

  // Get unread count (filtered for non-admins)
  app.get("/api/notifications/unread-count", async (req) => {
    const s = req.session
    return {
      count: s?.isAdmin
        ? db.getUnreadNotificationCount()
        : db.getUnreadNotificationCountForUser({ upn: s?.upn ?? null, sid: s?.sid ?? null }),
    }
  })

  // Mark one notification as read (owner only)
  app.post<{ Params: { id: string } }>("/api/notifications/:id/read", async (req, reply) => {
    const n = db.getNotification(req.params.id)
    if (!n || !canSee(req.session, n)) { reply.code(404); return { error: "Not found" } }
    db.markNotificationRead(req.params.id)
    return { ok: true }
  })

  // Mark all notifications as read (scoped for non-admins)
  app.post("/api/notifications/read-all", async (req) => {
    const s = req.session
    if (s?.isAdmin) {
      db.markAllNotificationsRead()
    } else {
      const list = db.listNotificationsForUser({ upn: s?.upn ?? null, sid: s?.sid ?? null }, 10_000)
      for (const n of list) if (n.read === 0) db.markNotificationRead(n.id)
    }
    return { ok: true }
  })

  // Execute a notification action (resume, etc.)
  app.post<{ Params: { id: string }; Body: { action: string; data?: Record<string, unknown> } }>(
    "/api/notifications/:id/action",
    async (req, reply) => {
      const n = db.getNotification(req.params.id)
      if (!n || !canSee(req.session, n)) { reply.code(404); return { error: "Not found" } }
      const { action, data } = req.body
      db.markNotificationRead(req.params.id)

      switch (action) {
        case "resume-run": {
          const runId = data?.runId as string
          if (!runId) { reply.code(400); return { error: "runId required" } }
          const newRunId = orchestrator.resumeRun(runId)
          if (!newRunId) { reply.code(404); return { error: "Cannot resume — no checkpoint" } }
          return { ok: true, runId: newRunId }
        }

        case "cancel-run": {
          const runId = data?.runId as string
          if (!runId) { reply.code(400); return { error: "runId required" } }
          orchestrator.cancelRun(runId)
          return { ok: true }
        }

        case "view-run":
          // Client handles navigation — just mark as read
          return { ok: true }

        case "rollback-run": {
          const runId = data?.runId as string
          if (!runId) { reply.code(400); return { error: "runId required" } }
          const { rollbackRun } = await import("../effects/index.js")
          const result = await rollbackRun(runId)
          return { ok: true, compensated: result.compensated, skipped: result.skipped, failed: result.failed.length }
        }

        case "apply-run-diff": {
          const runId = data?.runId as string
          if (!runId) { reply.code(400); return { error: "runId required" } }
          const result = await orchestrator.applyRunWorkspaceDiff(runId)
          if (!result) { reply.code(404); return { error: "No pending isolated workspace diff to apply" } }
          return {
            ok: true,
            runId,
            applied: result,
          }
        }

        default:
          return { ok: true }
      }
    },
  )
}
