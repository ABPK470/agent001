import { parseBoundaryJson } from "../../internal/parse-json.js"

/**
 * Notification transport — Personal. Scope from personal.read / personal.write.
 */

import {
  canResumeRun,
  canRollbackRun,
  type NotificationAction,
} from "@mia/shared-types"
import type { FastifyInstance } from "fastify"
import * as db from "../../infra/persistence/sqlite.js"
import { canAccessRun } from "../auth/service/access.js"
import { personal, viewingAsOf, type ViewingAs } from "../auth/service/viewing-as.js"
import {
  filterNotificationActionsForCapabilities,
  runCapabilityFlags,
} from "../../runtime/run-capability-actions.js"
import type { AgentOrchestrator } from "../../runtime/orchestrator.js"

async function canSee(
  viewingAs: ViewingAs,
  notification: { run_id: string | null }
): Promise<boolean> {
  if (!notification.run_id) return true
  const run = await db.getRun(notification.run_id)
  return canAccessRun(viewingAs, run ?? null)
}

export function registerNotificationRoutes(app: FastifyInstance, orchestrator: AgentOrchestrator): void {
  app.get<{ Querystring: { limit?: string } }>("/api/notifications", personal.read, async (req) => {
    const { viewingAsUpn } = viewingAsOf(req)
    const limit = Math.min(Number(req.query.limit) || 50, 200)
    const notifications = await db.listNotificationsForUser(viewingAsUpn, limit)
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

  app.get("/api/notifications/unread-count", personal.read, async (req) => {
    const { viewingAsUpn } = viewingAsOf(req)
    return { count: await db.getUnreadNotificationCountForUser(viewingAsUpn) }
  })

  app.post<{ Params: { id: string } }>("/api/notifications/:id/read", personal.write, async (req, reply) => {
    const viewingAs = viewingAsOf(req)
    const notification = await db.getNotification(req.params.id)
    if (!notification || !canSee(viewingAs, notification)) {
      reply.code(404)
      return { error: "Not found" }
    }
    await db.markNotificationRead(req.params.id)
    return { ok: true }
  })

  app.post("/api/notifications/read-all", personal.write, async (req) => {
    const { viewingAsUpn } = viewingAsOf(req)
    const notifications = await db.listNotificationsForUser(viewingAsUpn, 10_000)
    for (const notification of notifications)
      if (notification.read === 0) await db.markNotificationRead(notification.id)
    return { ok: true }
  })

  app.post<{ Params: { id: string }; Body: { action: string; data?: Record<string, unknown> } }>(
    "/api/notifications/:id/action",
    personal.write,
    async (req, reply) => {
      const viewingAs = viewingAsOf(req)
      const notification = await db.getNotification(req.params.id)
      if (!notification || !canSee(viewingAs, notification)) {
        reply.code(404)
        return { error: "Not found" }
      }
      const { action, data } = req.body
      await db.markNotificationRead(req.params.id)

      switch (action) {
        case "resume-run": {
          const runId = data?.runId as string
          if (!runId) {
            reply.code(400)
            return { error: "runId required" }
          }
          const run = await db.getRun(runId)
          const caps = await runCapabilityFlags(runId)
          if (!run || !canResumeRun(run.status, caps.hasCheckpoint)) {
            reply.code(409)
            return { error: "Resume not available for this run" }
          }
          const newRunId = await orchestrator.resumeRun(runId, req.session ?? null)
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
          await orchestrator.cancelRun(runId)
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
          const run = await db.getRun(runId)
          const caps = await runCapabilityFlags(runId)
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
          const { approveRunToolStep } = await import("../../runtime/service/run-tool-approval.js")
          return approveRunToolStep(orchestrator, approvalId, viewingAs)
        }
        case "deny-run-step": {
          const approvalId = data?.approvalId as string | undefined
          if (!approvalId) {
            reply.code(400)
            return { error: "approvalId required" }
          }
          const { denyRunToolStep } = await import("../../runtime/service/run-tool-approval.js")
          return denyRunToolStep(orchestrator, approvalId, viewingAs)
        }
        default:
          return { ok: true }
      }
    }
  )
}
