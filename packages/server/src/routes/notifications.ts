/**
 * Notification API routes.
 */

import type { FastifyInstance } from "fastify"
import * as db from "../db.js"
import type { AgentOrchestrator } from "../orchestrator.js"

export function registerNotificationRoutes(
  app: FastifyInstance,
  orchestrator: AgentOrchestrator,
): void {

  // List notifications
  app.get<{ Querystring: { limit?: string } }>("/api/notifications", async (req) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200)
    const notifications = db.listNotifications(limit)
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

  // Get unread count
  app.get("/api/notifications/unread-count", async () => {
    return { count: db.getUnreadNotificationCount() }
  })

  // Mark one notification as read
  app.post<{ Params: { id: string } }>("/api/notifications/:id/read", async (req) => {
    db.markNotificationRead(req.params.id)
    return { ok: true }
  })

  // Mark all notifications as read
  app.post("/api/notifications/read-all", async () => {
    db.markAllNotificationsRead()
    return { ok: true }
  })

  // Execute a notification action (resume, etc.)
  app.post<{ Params: { id: string }; Body: { action: string; data?: Record<string, unknown> } }>(
    "/api/notifications/:id/action",
    async (req, reply) => {
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
          const { rollbackRun } = await import("../effects.js")
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
