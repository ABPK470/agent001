/**
 * Sync routes — environment sync preview / execute / live progress.
 *
 *   POST /api/sync/preview                       → SyncPlan
 *   GET  /api/sync/plan/:planId                  → SyncPlan
 *   POST /api/sync/execute/:planId               → { success, error? }
 *   GET  /api/sync/execute/:planId/stream        → SSE progress events
 *   GET  /api/sync/environments                  → SyncEnvironment[]
 *   GET  /api/sync/recipes                       → SyncRecipeBundle (read-only)
 *   POST /api/sync/compare-catalogs              → drift report
 */

import {
    executeSync,
    getEnvironments,
    loadPlan,
    loadSyncRecipes,
    previewSync,
    searchEntities,
    type AgentHost,
    type EntityType,
    type ExecuteProgress,
} from "@mia/agent"
import type { FastifyInstance, FastifyReply } from "fastify"
import * as db from "../db/index.js"

interface PreviewBody {
  entityType: EntityType
  entityId: string | number
  source: string
  target: string
  force?: boolean
  enabledOptionalTables?: string[]
}

/**
 * Persist a sync action to the sync_audit table. The plan_id FK cascades
 * with the parent sync_runs row, so audit history disappears when the plan
 * is deleted. The legacy 'sync:<planId>' prefix in audit_log.run_id has
 * been retired.
 */
function auditSync(
  planId: string,
  actor: string,
  actorUpn: string | null,
  action: string,
  detail: Record<string, unknown>,
): void {
  try {
    db.recordSyncAudit({ planId, actor, actorUpn, action, detail })
  } catch (e) {
    console.error("auditSync failed:", e instanceof Error ? e.message : e)
  }
}

export function registerSyncRoutes(app: FastifyInstance, projectRoot: string, host: AgentHost): void {

  // ── Environments ────────────────────────────────────────────
  app.get("/api/sync/environments", async () => getEnvironments(host))

  // ── Recipes (read-only metadata) ────────────────────────────
  app.get("/api/sync/recipes", async () => loadSyncRecipes(host, projectRoot))

  // ── Entity search (typeahead by name) ───────────────────────
  app.get<{ Querystring: { entityType: string; source: string; q: string; limit?: string } }>(
    "/api/sync/search",
    async (req, reply) => {
      const { entityType, source, q, limit } = req.query
      if (!entityType || !source || !q) {
        reply.code(400)
        return { error: "entityType, source, and q are required" }
      }
      try {
        return await searchEntities(host, entityType as EntityType, source, q, limit ? Number(limit) : 200)
      } catch (e) {
        reply.code(400)
        return { error: e instanceof Error ? e.message : String(e) }
      }
    },
  )

  // ── Plan: preview ───────────────────────────────────────────
  app.post<{ Body: PreviewBody }>("/api/sync/preview", async (req, reply) => {

    const actor = req.session.upn
    const actorUpn = req.session.upn
    try {
      const plan = await previewSync({
        host,
        entityType: req.body.entityType,
        entityId: req.body.entityId,
        source: req.body.source,
        target: req.body.target,
        force: Boolean(req.body.force),
        enabledOptionalTables: Array.isArray(req.body.enabledOptionalTables) ? req.body.enabledOptionalTables : undefined,
      })
      auditSync(plan.planId, actor, actorUpn, "sync.preview", {
        entityType: req.body.entityType,
        entityId: req.body.entityId,
        source: req.body.source,
        target: req.body.target,
        force: Boolean(req.body.force),
        enabledOptionalTables: Array.isArray(req.body.enabledOptionalTables) ? req.body.enabledOptionalTables : [],
        totals: plan.totals,
        entityPolicies: plan.entityPolicies ?? null,
      })
      return plan
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // Preview failed before a plan was minted, so there is no plan_id to
      // FK against. Skip audit — the failure is logged via the agent's
      // emit() chain and visible in the structured event log.
      console.warn(`[sync.preview] failed for ${req.body.entityType} ${req.body.entityId}: ${msg}`)
      reply.code(400)
      return { error: msg }
    }
  })

  // ── Plan: load by id ────────────────────────────────────────
  app.get<{ Params: { planId: string } }>("/api/sync/plan/:planId", async (req, reply) => {
    const plan = loadPlan(host, req.params.planId)
    if (!plan) {
      reply.code(404)
      return { error: `Plan ${req.params.planId} not found or expired.` }
    }
    return plan
  })

  // ── Execute (synchronous; for tooling, not UI) ──────────────
  app.post<{ Params: { planId: string } }>("/api/sync/execute/:planId", async (req, reply) => {

    const actor = req.session.upn
    const actorUpn = req.session.upn
    const plan = loadPlan(host, req.params.planId)
    const planDetail = plan
      ? { entityType: plan.recipeSnapshot.entityType, entityId: plan.entity.id, entityName: plan.entity.displayName, source: plan.source, target: plan.target, totals: plan.totals, entityPolicies: plan.entityPolicies ?? null }
      : {}
    auditSync(req.params.planId, actor, actorUpn, "sync.execute.start", planDetail)
    try {
      const result = await executeSync(req.params.planId, { host, confirm: true, userUpn: actor })
      auditSync(req.params.planId, actor, actorUpn,
        result.success ? "sync.execute.completed" : "sync.execute.failed",
        { ...planDetail, error: result.error ?? null })
      if (!result.success) reply.code(500)
      return result
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      auditSync(req.params.planId, actor, actorUpn, "sync.execute.failed", { ...planDetail, error: msg })
      reply.code(400)
      return { error: msg }
    }
  })

  // ── Execute (SSE stream; UI uses this) ──────────────────────
  app.get<{ Params: { planId: string } }>("/api/sync/execute/:planId/stream", async (req, reply) => {

    const actor = req.session.upn
    const actorUpn = req.session.upn
    const plan = loadPlan(host, req.params.planId)
    const planDetail = plan
      ? { entityType: plan.recipeSnapshot.entityType, entityId: plan.entity.id, entityName: plan.entity.displayName, source: plan.source, target: plan.target, totals: plan.totals, entityPolicies: plan.entityPolicies ?? null }
      : {}
    auditSync(req.params.planId, actor, actorUpn, "sync.execute.start", planDetail)
    setupSse(reply)
    const send = (event: ExecuteProgress) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
    const heartbeat = setInterval(() => reply.raw.write(`: hb\n\n`), 25_000)
    req.raw.on("close", () => clearInterval(heartbeat))

    try {
      const result = await executeSync(req.params.planId, { host, confirm: true, onProgress: send, userUpn: actor })
      // Terminal event (completed/failed) already sent by orchestrator via onProgress
      auditSync(req.params.planId, actor, actorUpn,
        result.success ? "sync.execute.completed" : "sync.execute.failed",
        { ...planDetail, error: result.error ?? null })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      send({ type: "failed", error: msg })
      auditSync(req.params.planId, actor, actorUpn, "sync.execute.failed",
        { ...planDetail, error: msg })
    } finally {
      clearInterval(heartbeat)
      reply.raw.end()
    }
  })

  // ── History — recent sync audit entries ─────────────────────
  app.get<{ Querystring: { limit?: string } }>("/api/sync/history", async (req, _reply) => {
    const isAdmin = !!req.session.isAdmin
    const viewerUpn = req.session.upn
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100))
    // sync_audit-driven rows (manual UI-initiated syncs).
    const auditRowsRaw = db.listRecentSyncAudit(limit, isAdmin ? undefined : { actorUpn: viewerUpn })
    const auditRows = auditRowsRaw.map((r) => ({
      planId: `sync:${r.plan_id}`,
      actor: r.actor,
      action: r.action,
      detail: r.detail,
      timestamp: r.timestamp,
    }))
    const auditPlanIds = new Set(auditRowsRaw.map((r) => r.plan_id))
    // Agent-initiated syncs — present in sync_runs but not in sync_audit.
    // Emit TWO rows per run: a synthetic sync.preview (so the UI can show the
    // entity name and preview totals) followed by the execute result row.
    const agentRows = db.listSyncRuns(limit)
      .filter((r) => !auditPlanIds.has(r.plan_id))
      .filter((r) => isAdmin || (viewerUpn != null && r.actor_upn === viewerUpn))
      .flatMap((r) => {
        const previewTotals = {
          insert: r.preview_inserts,
          update: r.preview_updates,
          delete: r.preview_deletes,
        }
        const executeTotals = r.executed_inserts === null ? null : {
          insert: r.executed_inserts,
          update: r.executed_updates,
          delete: r.executed_deletes,
        }
        const actor = r.actor_upn
        const entityDetail = {
          entityType: r.entity_type, entityId: r.entity_id,
          entityName: r.entity_display_name,
          source: r.source, target: r.target,
        }
        const previewRow = {
          planId: `sync:${r.plan_id}`,
          actor,
          action: "sync.preview",
          detail: JSON.stringify({ ...entityDetail, totals: previewTotals }),
          timestamp: r.started_at,
        }
        if (r.status === "started" || r.status === "preview") return [previewRow]
        const execAction = r.status === "success" ? "sync.execute.completed" : "sync.execute.failed"
        const execRow = {
          planId: `sync:${r.plan_id}`,
          actor,
          action: execAction,
          detail: JSON.stringify({ ...entityDetail, totals: executeTotals, error: r.error ?? null }),
          timestamp: r.finished_at ?? r.started_at,
        }
        return [previewRow, execRow]
      })
    const allRows = [...auditRows, ...agentRows]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit)
    return allRows.map((r) => {
      let parsed: unknown = null
      try { parsed = JSON.parse(r.detail) } catch { /* keep null */ }
      // Normalise timestamp to ISO 8601 with Z — SQLite datetime('now') returns
      // "YYYY-MM-DD HH:MM:SS" (no timezone marker). Without the Z, JS Date
      // parses it as local time instead of UTC, making timeAgo() report wrong deltas.
      const ts = r.timestamp.includes("T") || r.timestamp.endsWith("Z")
        ? r.timestamp
        : r.timestamp.replace(" ", "T") + "Z"
      return { ...r, timestamp: ts, detail: parsed }
    })
  })

  // ── Recent sync runs (one row per executeSync) ──────────────
  // Used by the UI on cold start to restore the EnvSync widget to the
  // most recent manual sync the user ran — the sync-equivalent of the
  // agent loop's "auto-select latest run" behaviour.
  app.get<{ Querystring: { limit?: string } }>("/api/sync/runs", async (req, _reply) => {
    const isAdmin = !!req.session.isAdmin
    const viewerUpn = req.session.upn
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25))
    return db.listSyncRuns(limit)
      .filter((r) => isAdmin || (viewerUpn && r.actor_upn === viewerUpn))
      .map((r) => ({
      planId: r.plan_id,
      entityType: r.entity_type,
      entityId: r.entity_id,
      entityDisplayName: r.entity_display_name,
      source: r.source,
      target: r.target,
      actorUpn: r.actor_upn,
      status: r.status,
      error: r.error,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      durationMs: r.duration_ms,
    }))
  })
}

function setupSse(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  })
}
