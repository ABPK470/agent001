/**
 * Admin observability transport routes.
 */

import type { FastifyInstance } from "fastify"
import { listSessions, listUserHistory, listUsersWithStats } from "../adapters/persistence/sessions.js"
import { getDb } from "../adapters/persistence/sqlite.js"
import type { AgentOrchestrator } from "../application/shell/agent-orchestrator.js"

export function registerAdminRoutes(app: FastifyInstance, orchestrator: AgentOrchestrator): void {
	app.get("/api/admin/sessions", async (req, reply) => {
		if (!req.session.isAdmin) { reply.code(403); return { error: "admin only" } }
		const since = Number(((req.query as Record<string, string>)?.["sinceSeconds"]) ?? "604800")
		const sessions = listSessions({ sinceSeconds: since })
		const onlineCutoff = Date.now() - 60_000
		return {
			sessions: sessions.map((session) => ({
				sid: session.sid,
				upn: session.upn,
				displayName: session.display_name,
				isAdmin: session.is_admin === 1,
				ip: session.ip,
				userAgent: session.user_agent,
				createdAt: session.created_at,
				lastSeenAt: session.last_seen_at,
				online: Date.parse(session.last_seen_at + "Z") >= onlineCutoff,
			})),
		}
	})

	app.get("/api/admin/active-runs", async (req, reply) => {
		if (!req.session.isAdmin) { reply.code(403); return { error: "admin only" } }
		const activeIds = orchestrator.getActiveRunIds()
		if (activeIds.length === 0) return { runs: [] }
		const placeholders = activeIds.map(() => "?").join(",")
		const rows = getDb().prepare(`
				SELECT id, goal, status, step_count, created_at, session_id, upn, display_name
				FROM runs
				WHERE id IN (${placeholders})
				ORDER BY created_at DESC
			`).all(...activeIds) as Array<{
				id: string
				goal: string
				status: string
				step_count: number
				created_at: string
				session_id: string
				upn: string
				display_name: string
			}>
		return {
			runs: rows.map((row) => ({
				runId: row.id,
				goal: row.goal,
				status: row.status,
				stepCount: row.step_count,
				createdAt: row.created_at,
				sessionId: row.session_id,
				upn: row.upn,
				displayName: row.display_name,
			})),
		}
	})

	app.get("/api/admin/users", async (req, reply) => {
		if (!req.session.isAdmin) { reply.code(403); return { error: "admin only" } }
		const q = req.query as Record<string, string | undefined>
		const sinceSeconds = Number(q["sinceSeconds"] ?? "604800")
		const activityWindowSeconds = Number(q["activityWindowSeconds"] ?? "86400")
		const users = listUsersWithStats({ sinceSeconds, activityWindowSeconds })

		const activeIds = orchestrator.getActiveRunIds()
		let activeByUpn = new Map<string, number>()
		if (activeIds.length > 0) {
			const placeholders = activeIds.map(() => "?").join(",")
			const rows = getDb().prepare(`
				SELECT upn, COUNT(*) AS n
				FROM runs WHERE id IN (${placeholders})
				GROUP BY upn
			`).all(...activeIds) as Array<{ upn: string; n: number }>
			activeByUpn = new Map(rows.map((row) => [row.upn, row.n]))
		}

		return {
			users: users.map((user) => ({ ...user, activeRuns: activeByUpn.get(user.upn) ?? 0 })),
			summary: {
				users: users.length,
				online: users.filter((user) => user.online).length,
				runsInFlight: activeIds.length,
				runs24h: users.reduce((acc, user) => acc + user.runs24h, 0),
				tokens24h: users.reduce((acc, user) => acc + user.totalTokens24h, 0),
			},
		}
	})

	app.get<{ Params: { identifier: string } }>("/api/admin/users/:identifier/runs", async (req, reply) => {
		if (!req.session.isAdmin) { reply.code(403); return { error: "admin only" } }
		const limit = Math.min(200, Math.max(1, Number((req.query as Record<string, string>)?.["limit"] ?? "25")))
		const offset = Math.max(0, Number((req.query as Record<string, string>)?.["offset"] ?? "0"))
		const identifier = decodeURIComponent(req.params.identifier)
		const { runs, total } = listUserHistory(identifier, limit, offset)
		return { runs, total, limit, offset }
	})
}
