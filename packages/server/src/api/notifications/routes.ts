import { parseBoundaryJson } from "../../internal/parse-json.js"

/**
 * Notification transport routes.
 */

import {
  canResumeRun,
  canRollbackRun,
  type NotificationAction,
} from "@mia/shared-types"
import type { FastifyInstance } from "fastify"
import * as db from "../../infra/persistence/sqlite.js"
import { canAccessRun } from "../auth/service/access.js"
import {
  filterNotificationActionsForCapabilities,
  runCapabilityFlags,
} from "../runs/run-capability-actions.js"
import type { AgentOrchestrator } from "../runs/orchestrator.js"

function canSee(
  session: { isAdmin?: boolean; upn?: string | null; sid?: string } | undefined,
  notification: { run_id: string | null }
): boolean {
  if (session?.isAdmin) return true
  if (!notification.run_id) return true
  const run = db.getRun(notification.run_id)
  return canAccessRun(session as never, run ?? null)
}

export function registerNotificationRoutes(app: FastifyInstance, orchestrator: AgentOrchestrator): void {
  app.get<{ Querystring: { limit?: string } }>("/api/notifications", async (req) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200)
    const session = req.session
    const notifications = session?.isAdmin
      ? db.listNotifications(limit)
      : db.listNotificationsForUser(session!.upn, limit)
    return notifications.map((notification) => {
      const actions = parseBoundaryJson(notification.actions) as NotificationAction[]
      return {
        id: notification.id,
        type: notification.type,
        title: notification.title,
        message: notification.message,
        runId: notification.run_id,
        stepId: notification.step_id,
        actions: filterNotificationActionsForCapabilities(notification.run_id, actions),
        read: notification.read === 1,
        createdAt: notification.created_at,
      }
    })
  })

  app.get("/api/notifications/unread-count", async (req) => {
    const session = req.session
    return {
      count: session?.isAdmin
        ? db.getUnreadNotificationCount()
        : db.getUnreadNotificationCountForUser(session!.upn)
    }
  })

  app.post<{ Params: { id: string } }>("/api/notifications/:id/read", async (req, reply) => {
    const notification = db.getNotification(req.params.id)
    if (!notification || !canSee(req.session, notification)) {
      reply.code(404)
      return { error: "Not found" }
    }
    db.markNotificationRead(req.params.id)
    return { ok: true }
  })

  app.post("/api/notifications/read-all", async (req) => {
    const session = req.session
    if (session?.isAdmin) {
      db.markAllNotificationsRead()
    } else {
      const notifications = db.listNotificationsForUser(session!.upn, 10_000)
      for (const notification of notifications)
        if (notification.read === 0) db.markNotificationRead(notification.id)
    }
    return { ok: true }
  })

  app.post<{ Params: { id: string }; Body: { action: string; data?: Record<string, unknown> } }>(
    "/api/notifications/:id/action",
    async (req, reply) => {
      const notification = db.getNotification(req.params.id)
      if (!notification || !canSee(req.session, notification)) {
        reply.code(404)
        return { error: "Not found" }
      }
      const { action, data } = req.body
      db.markNotificationRead(req.params.id)

      switch (action) {
        case "resume-run": {
          const runId = data?.runId as string
          if (!runId) {
            reply.code(400)
            return { error: "runId required" }
          }
          const run = db.getRun(runId)
          const caps = runCapabilityFlags(runId)
          if (!run || !canResumeRun(run.status, caps.hasCheckpoint)) {
            reply.code(409)
            return { error: "Resume not available for this run" }
          }
          const newRunId = orchestrator.resumeRun(runId, req.session ?? null)
          if (!newRunId) {
            reply.code(404)
            return { error: "Cannot resume — no checkpoint" }
          }
          return { ok: true, runId: newRunId }
        }
        case "cancel-run": {
          const runId = data?.runId as string
          if (!runId) {
            reply.code(400)
            return { error: "runId required" }
          }
          orchestrator.cancelRun(runId)
          return { ok: true }
        }
        case "view-run":
          return { ok: true }
        case "rollback-run": {
          const runId = data?.runId as string
          if (!runId) {
            reply.code(400)
            return { error: "runId required" }
          }
          const run = db.getRun(runId)
          const caps = runCapabilityFlags(runId)
          if (!run || !canRollbackRun(run.status, { rollbackAvailable: caps.rollbackAvailable })) {
            reply.code(409)
            return { error: "Nothing left to roll back" }
          }
          const { rollbackRun } = await import("../../infra/effects/index.js")
          const result = await rollbackRun(runId)
          return {
            ok: true,
            compensated: result.compensated,
            skipped: result.skipped,
            failed: result.failed.length
          }
        }
        case "apply-run-diff": {
          const runId = data?.runId as string
          if (!runId) {
            reply.code(400)
            return { error: "runId required" }
          }
          const result = await orchestrator.applyRunWorkspaceDiff(runId)
          if (!result) {
            reply.code(404)
            return { error: "No pending isolated workspace diff to apply" }
          }
          return { ok: true, runId, applied: result }
        }
        case "approve-run-step": {
          const approvalId = data?.approvalId as string | undefined
          if (!approvalId) {
            reply.code(400)
            return { error: "approvalId required" }
          }
          const { approveRunToolStep } = await import("../runs/service/run-tool-approval.js")
          return approveRunToolStep(orchestrator, approvalId, req.session ?? null)
        }
        case "deny-run-step": {
          const approvalId = data?.approvalId as string | undefined
          if (!approvalId) {
            reply.code(400)
            return { error: "approvalId required" }
          }
          const { denyRunToolStep } = await import("../runs/service/run-tool-approval.js")
          return denyRunToolStep(orchestrator, approvalId, req.session ?? null)
        }
        default:
          return { ok: true }
      }
    }
  )
}
