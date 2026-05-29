/**
 * Notification transport routes.
 */

import type { FastifyInstance } from "fastify"
import { canAccessRun } from "../adapters/auth/access.js"
import * as db from "../adapters/persistence/sqlite.js"
import type { AgentOrchestrator } from "../application/shell/agent-orchestrator.js"

function canSee(session: { isAdmin?: boolean; upn?: string | null; sid?: string } | undefined, notification: { run_id: string | null }): boolean {
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
			: db.listNotificationsForUser({ upn: session?.upn ?? null, sid: session?.sid ?? null }, limit)
		return notifications.map((notification) => ({
			id: notification.id,
			type: notification.type,
			title: notification.title,
			message: notification.message,
			runId: notification.run_id,
			stepId: notification.step_id,
			actions: JSON.parse(notification.actions),
			read: notification.read === 1,
			createdAt: notification.created_at,
		}))
	})

	app.get("/api/notifications/unread-count", async (req) => {
		const session = req.session
		return {
			count: session?.isAdmin
				? db.getUnreadNotificationCount()
				: db.getUnreadNotificationCountForUser({ upn: session?.upn ?? null, sid: session?.sid ?? null }),
		}
	})

	app.post<{ Params: { id: string } }>("/api/notifications/:id/read", async (req, reply) => {
		const notification = db.getNotification(req.params.id)
		if (!notification || !canSee(req.session, notification)) { reply.code(404); return { error: "Not found" } }
		db.markNotificationRead(req.params.id)
		return { ok: true }
	})

	app.post("/api/notifications/read-all", async (req) => {
		const session = req.session
		if (session?.isAdmin) {
			db.markAllNotificationsRead()
		} else {
			const notifications = db.listNotificationsForUser({ upn: session?.upn ?? null, sid: session?.sid ?? null }, 10_000)
			for (const notification of notifications) if (notification.read === 0) db.markNotificationRead(notification.id)
		}
		return { ok: true }
	})

	app.post<{ Params: { id: string }; Body: { action: string; data?: Record<string, unknown> } }>("/api/notifications/:id/action", async (req, reply) => {
		const notification = db.getNotification(req.params.id)
		if (!notification || !canSee(req.session, notification)) { reply.code(404); return { error: "Not found" } }
		const { action, data } = req.body
		db.markNotificationRead(req.params.id)

		switch (action) {
			case "resume-run": {
				const runId = data?.runId as string
				if (!runId) { reply.code(400); return { error: "runId required" } }
				const newRunId = orchestrator.resumeRun(runId, req.session ?? null)
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
				return { ok: true }
			case "rollback-run": {
				const runId = data?.runId as string
				if (!runId) { reply.code(400); return { error: "runId required" } }
				const { rollbackRun } = await import("../adapters/effects/index.js")
				const result = await rollbackRun(runId)
				return { ok: true, compensated: result.compensated, skipped: result.skipped, failed: result.failed.length }
			}
			case "apply-run-diff": {
				const runId = data?.runId as string
				if (!runId) { reply.code(400); return { error: "runId required" } }
				const result = await orchestrator.applyRunWorkspaceDiff(runId)
				if (!result) { reply.code(404); return { error: "No pending isolated workspace diff to apply" } }
				return { ok: true, runId, applied: result }
			}
			default:
				return { ok: true }
		}
	})
}
