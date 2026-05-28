/**
 * Sync transport routes.
 */

import { type AgentHost } from "@mia/agent"
import { executeSync, getEnvironments, loadPlan, loadPublishedSyncRecipeBundle, previewSync, searchEntities, type EntityType, type ExecuteProgress } from "@mia/sync"
import type { FastifyInstance, FastifyReply } from "fastify"
import * as db from "../adapters/persistence/sqlite.js"
import { buildSyncAuditDetail, loadPersistedSyncPlanSummary, summarizeSyncPlan } from "../domain/sync-plan-summary.js"
import { rebuildLiveSyncEnvironments } from "../domain/sync/live-environments.js"

interface PreviewBody {
	entityType: EntityType
	entityId: string | number
	source: string
	target: string
	force?: boolean
	enabledOptionalTables?: string[]
}

function auditSync(planId: string, actor: string, actorUpn: string | null, action: string, detail: Record<string, unknown>): void {
	try {
		db.recordSyncAudit({ planId, actor, actorUpn, action, detail })
	} catch (error) {
		console.error("auditSync failed:", error instanceof Error ? error.message : error)
	}
}

export function registerSyncRoutes(app: FastifyInstance, projectRoot: string, host: AgentHost): void {
	app.get("/api/sync/environments", async () => {
		rebuildLiveSyncEnvironments(host)
		return getEnvironments(host)
	})
	app.get("/api/sync/recipes", async () => loadPublishedSyncRecipeBundle(host, projectRoot))
	app.get<{ Querystring: { entityType: string; source: string; q: string; limit?: string } }>("/api/sync/search", async (req, reply) => {
		rebuildLiveSyncEnvironments(host)
		const { entityType, source, q, limit } = req.query
		if (!entityType || !source || !q) {
			reply.code(400)
			return { error: "entityType, source, and q are required" }
		}
		try {
			return await searchEntities(host, entityType as EntityType, source, q, limit ? Number(limit) : 200)
		} catch (error) {
			reply.code(400)
			return { error: error instanceof Error ? error.message : String(error) }
		}
	})

	app.post<{ Body: PreviewBody }>("/api/sync/preview", async (req, reply) => {
		const actor = req.session.upn
		const actorUpn = req.session.upn
		try {
			rebuildLiveSyncEnvironments(host)
			const plan = await previewSync({ host, entityType: req.body.entityType, entityId: req.body.entityId, source: req.body.source, target: req.body.target, force: Boolean(req.body.force), enabledOptionalTables: Array.isArray(req.body.enabledOptionalTables) ? req.body.enabledOptionalTables : undefined, userUpn: actorUpn })
			const planSummary = summarizeSyncPlan(plan)
			auditSync(plan.planId, actor, actorUpn, "sync.preview", planSummary
				? { ...buildSyncAuditDetail(planSummary, plan.totals), force: Boolean(req.body.force), enabledOptionalTables: Array.isArray(req.body.enabledOptionalTables) ? req.body.enabledOptionalTables : [] }
				: { entityType: req.body.entityType, entityId: req.body.entityId, source: req.body.source, target: req.body.target, force: Boolean(req.body.force), enabledOptionalTables: Array.isArray(req.body.enabledOptionalTables) ? req.body.enabledOptionalTables : [], totals: plan.totals })
			return plan
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error)
			console.warn(`[sync.preview] failed for ${req.body.entityType} ${req.body.entityId}: ${msg}`)
			reply.code(400)
			return { error: msg }
		}
	})

	app.get<{ Params: { planId: string } }>("/api/sync/plan/:planId", async (req, reply) => {
		const plan = loadPlan(host, req.params.planId)
		if (!plan) {
			reply.code(404)
			return { error: `Plan ${req.params.planId} not found or expired.` }
		}
		return plan
	})

	app.post<{ Params: { planId: string } }>("/api/sync/execute/:planId", async (req, reply) => {
		const actor = req.session.upn
		const actorUpn = req.session.upn
		rebuildLiveSyncEnvironments(host)
		const plan = loadPlan(host, req.params.planId)
		const planSummary = plan ? summarizeSyncPlan(plan) : loadPersistedSyncPlanSummary(req.params.planId)
		const planDetail = planSummary && plan ? buildSyncAuditDetail(planSummary, plan.totals) : {}
		auditSync(req.params.planId, actor, actorUpn, "sync.execute.start", planDetail)
		try {
			const result = await executeSync(req.params.planId, { host, confirm: true, userUpn: actor })
			auditSync(req.params.planId, actor, actorUpn, result.success ? "sync.execute.completed" : "sync.execute.failed", { ...planDetail, error: result.error ?? null })
			if (!result.success) reply.code(500)
			return result
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error)
			auditSync(req.params.planId, actor, actorUpn, "sync.execute.failed", { ...planDetail, error: msg })
			reply.code(400)
			return { error: msg }
		}
	})

	app.get<{ Params: { planId: string } }>("/api/sync/execute/:planId/stream", async (req, reply) => {
		const actor = req.session.upn
		const actorUpn = req.session.upn
		rebuildLiveSyncEnvironments(host)
		const plan = loadPlan(host, req.params.planId)
		const planSummary = plan ? summarizeSyncPlan(plan) : loadPersistedSyncPlanSummary(req.params.planId)
		const planDetail = planSummary && plan ? buildSyncAuditDetail(planSummary, plan.totals) : {}
		auditSync(req.params.planId, actor, actorUpn, "sync.execute.start", planDetail)
		setupSse(reply)
		const send = (event: ExecuteProgress) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
		const heartbeat = setInterval(() => reply.raw.write(`: hb\n\n`), 25_000)
		req.raw.on("close", () => clearInterval(heartbeat))
		try {
			const result = await executeSync(req.params.planId, { host, confirm: true, onProgress: send, userUpn: actor })
			auditSync(req.params.planId, actor, actorUpn, result.success ? "sync.execute.completed" : "sync.execute.failed", { ...planDetail, error: result.error ?? null })
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error)
			send({ type: "failed", error: msg })
			auditSync(req.params.planId, actor, actorUpn, "sync.execute.failed", { ...planDetail, error: msg })
		} finally {
			clearInterval(heartbeat)
			reply.raw.end()
		}
	})

	app.get<{ Querystring: { limit?: string } }>("/api/sync/history", async (req) => {
		const isAdmin = !!req.session.isAdmin
		const viewerUpn = req.session.upn
		const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100))
		const auditRowsRaw = db.listRecentSyncAudit(limit, isAdmin ? undefined : { actorUpn: viewerUpn })
		const auditRows = auditRowsRaw.map((row) => ({ planId: `sync:${row.plan_id}`, actor: row.actor, action: row.action, detail: row.detail, timestamp: row.timestamp }))
		const auditPlanIds = new Set(auditRowsRaw.map((row) => row.plan_id))
		const agentRows = db.listSyncRuns(limit)
			.filter((row) => !auditPlanIds.has(row.plan_id))
			.filter((row) => isAdmin || (viewerUpn != null && row.actor_upn === viewerUpn))
			.flatMap((row) => {
				const previewTotals = { insert: row.preview_inserts, update: row.preview_updates, delete: row.preview_deletes }
				const executeTotals = row.executed_inserts === null ? null : { insert: row.executed_inserts, update: row.executed_updates, delete: row.executed_deletes }
				const actor = row.actor_upn
				const summary = loadPersistedSyncPlanSummary(row.plan_id)
				const previewDetail = summary ? buildSyncAuditDetail(summary, previewTotals) : { entityType: row.entity_type, entityId: row.entity_id, entityName: row.entity_display_name, source: row.source, target: row.target, totals: previewTotals }
				const previewRow = { planId: `sync:${row.plan_id}`, actor, action: "sync.preview", detail: JSON.stringify(previewDetail), timestamp: row.started_at }
				if (row.status === "started" || row.status === "preview") return [previewRow]
				const execAction = row.status === "success" ? "sync.execute.completed" : "sync.execute.failed"
				const execDetail = summary ? buildSyncAuditDetail(summary, executeTotals, row.error ?? null) : { entityType: row.entity_type, entityId: row.entity_id, entityName: row.entity_display_name, source: row.source, target: row.target, totals: executeTotals, error: row.error ?? null }
				const execRow = { planId: `sync:${row.plan_id}`, actor, action: execAction, detail: JSON.stringify(execDetail), timestamp: row.finished_at ?? row.started_at }
				return [previewRow, execRow]
			})
		return [...auditRows, ...agentRows].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit).map((row) => {
			let parsed: unknown = null
			try { parsed = JSON.parse(row.detail) } catch {}
			const ts = row.timestamp.includes("T") || row.timestamp.endsWith("Z") ? row.timestamp : row.timestamp.replace(" ", "T") + "Z"
			return { ...row, timestamp: ts, detail: parsed }
		})
	})

	app.get<{ Querystring: { limit?: string } }>("/api/sync/runs", async (req) => {
		const isAdmin = !!req.session.isAdmin
		const viewerUpn = req.session.upn
		const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25))
		return db.listSyncRuns(limit)
			.filter((row) => isAdmin || (viewerUpn && row.actor_upn === viewerUpn))
			.map((row) => ({
				planId: row.plan_id,
				entityType: row.entity_type,
				entityId: row.entity_id,
				entityDisplayName: row.entity_display_name,
				source: row.source,
				target: row.target,
				actorUpn: row.actor_upn,
				status: row.status,
				error: row.error,
				startedAt: row.started_at,
				finishedAt: row.finished_at,
				durationMs: row.duration_ms,
			}))
	})
}

function setupSse(reply: FastifyReply): void {
	reply.raw.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	})
}
