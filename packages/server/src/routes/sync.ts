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
    type EntityType,
    type ExecuteProgress,
} from "@agent001/agent"
import type { FastifyInstance, FastifyReply } from "fastify"
import * as db from "../db.js"

interface PreviewBody {
  entityType: EntityType
  entityId: string | number
  source: string
  target: string
  force?: boolean
  enabledOptionalTables?: string[]
}

/**
 * Persist a sync action to the audit_log table. Sync ops have no agent run,
 * so we use a synthetic run_id of "sync:<planId>" (or "sync:<entityType>:<entityId>"
 * for preview-time failures before a plan exists). Searchable via:
 *   SELECT * FROM audit_log WHERE run_id LIKE 'sync:%'
 */
function auditSync(
  runId: string,
  actor: string,
  action: string,
  detail: Record<string, unknown>,
): void {
  try {
    db.saveAudit({
      run_id: runId,
      actor,
      action,
      detail: JSON.stringify(detail),
      timestamp: new Date().toISOString(),
    })
  } catch (e) {
    console.error("auditSync failed:", e instanceof Error ? e.message : e)
  }
}

export function registerSyncRoutes(app: FastifyInstance, projectRoot: string): void {

  // ── Environments ────────────────────────────────────────────
  app.get("/api/sync/environments", async () => getEnvironments())

  // ── Recipes (read-only metadata) ────────────────────────────
  app.get("/api/sync/recipes", async () => loadSyncRecipes(projectRoot))

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
        return await searchEntities(entityType as EntityType, source, q, limit ? Number(limit) : 200)
      } catch (e) {
        reply.code(400)
        return { error: e instanceof Error ? e.message : String(e) }
      }
    },
  )

  // ── Plan: preview ───────────────────────────────────────────
  app.post<{ Body: PreviewBody }>("/api/sync/preview", async (req, reply) => {

    const actor = req.session?.upn ?? req.session?.displayName ?? "anonymous"
    try {
      const plan = await previewSync({
        entityType: req.body.entityType,
        entityId: req.body.entityId,
        source: req.body.source,
        target: req.body.target,
        force: Boolean(req.body.force),
        enabledOptionalTables: Array.isArray(req.body.enabledOptionalTables) ? req.body.enabledOptionalTables : undefined,
      })
      auditSync(`sync:${plan.planId}`, actor, "sync.preview", {
        entityType: req.body.entityType,
        entityId: req.body.entityId,
        source: req.body.source,
        target: req.body.target,
        force: Boolean(req.body.force),
        enabledOptionalTables: Array.isArray(req.body.enabledOptionalTables) ? req.body.enabledOptionalTables : [],
        totals: plan.totals,
      })
      return plan
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      auditSync(
        `sync:${req.body.entityType}:${req.body.entityId}`,
        actor,
        "sync.preview.failed",
        { source: req.body.source, target: req.body.target, error: msg },
      )
      reply.code(400)
      return { error: msg }
    }
  })

  // ── Plan: load by id ────────────────────────────────────────
  app.get<{ Params: { planId: string } }>("/api/sync/plan/:planId", async (req, reply) => {
    const plan = loadPlan(req.params.planId)
    if (!plan) {
      reply.code(404)
      return { error: `Plan ${req.params.planId} not found or expired.` }
    }
    return plan
  })

  // ── Execute (synchronous; for tooling, not UI) ──────────────
  app.post<{ Params: { planId: string } }>("/api/sync/execute/:planId", async (req, reply) => {

    const actor = req.session?.upn ?? req.session?.displayName ?? "anonymous"
    const plan = loadPlan(req.params.planId)
    const planDetail = plan
      ? { entityType: plan.recipeSnapshot.entityType, entityId: plan.entity.id, entityName: plan.entity.displayName, source: plan.source, target: plan.target, totals: plan.totals }
      : {}
    auditSync(`sync:${req.params.planId}`, actor, "sync.execute.start", planDetail)
    try {
      const result = await executeSync(req.params.planId, { confirm: true, userUpn: actor })
      auditSync(`sync:${req.params.planId}`, actor,
        result.success ? "sync.execute.completed" : "sync.execute.failed",
        { ...planDetail, error: result.error ?? null })
      if (!result.success) reply.code(500)
      return result
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      auditSync(`sync:${req.params.planId}`, actor, "sync.execute.failed", { ...planDetail, error: msg })
      reply.code(400)
      return { error: msg }
    }
  })

  // ── Execute (SSE stream; UI uses this) ──────────────────────
  app.get<{ Params: { planId: string } }>("/api/sync/execute/:planId/stream", async (req, reply) => {

    const actor = req.session?.upn ?? req.session?.displayName ?? "anonymous"
    const plan = loadPlan(req.params.planId)
    const planDetail = plan
      ? { entityType: plan.recipeSnapshot.entityType, entityId: plan.entity.id, entityName: plan.entity.displayName, source: plan.source, target: plan.target, totals: plan.totals }
      : {}
    auditSync(`sync:${req.params.planId}`, actor, "sync.execute.start", planDetail)
    setupSse(reply)
    const send = (event: ExecuteProgress) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
    const heartbeat = setInterval(() => reply.raw.write(`: hb\n\n`), 25_000)
    req.raw.on("close", () => clearInterval(heartbeat))

    try {
      const result = await executeSync(req.params.planId, { confirm: true, onProgress: send, userUpn: actor })
      // Terminal event (completed/failed) already sent by orchestrator via onProgress
      auditSync(`sync:${req.params.planId}`, actor,
        result.success ? "sync.execute.completed" : "sync.execute.failed",
        { ...planDetail, error: result.error ?? null })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      send({ type: "failed", error: msg })
      auditSync(`sync:${req.params.planId}`, actor, "sync.execute.failed",
        { ...planDetail, error: msg })
    } finally {
      clearInterval(heartbeat)
      reply.raw.end()
    }
  })

  // ── History — recent sync audit entries ─────────────────────
  app.get<{ Querystring: { limit?: string } }>("/api/sync/history", async (req, _reply) => {
    const isAdmin = !!req.session?.isAdmin
    const viewerUpn = req.session?.upn ?? null
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100))
    // Audit-log rows (manual syncs — backward compat)
    const auditRowsRaw = db.getDb()
      .prepare(`
        SELECT run_id AS planId, actor, action, detail, timestamp
        FROM audit_log
        WHERE run_id LIKE 'sync:%'
        ORDER BY timestamp DESC
        LIMIT ?
      `)
      .all(limit) as Array<{ planId: string; actor: string; action: string; detail: string; timestamp: string }>
    const auditRows = isAdmin
      ? auditRowsRaw
      : auditRowsRaw.filter((r) => viewerUpn != null && r.actor === viewerUpn)
    const auditPlanIds = new Set(auditRows.map((r) => r.planId.replace(/^sync:/, "")))
    // Agent-initiated syncs — present in sync_runs but not in audit_log.
    // Emit TWO rows per run: a synthetic sync.preview (so the UI can show the
    // entity name and preview totals) followed by the execute result row.
    const agentRows = db.listSyncRuns(limit)
      .filter((r) => !auditPlanIds.has(r.plan_id))
      .filter((r) => isAdmin || (viewerUpn != null && r.actor_upn === viewerUpn))
      .flatMap((r) => {
        let previewTotals: unknown = null
        try { previewTotals = JSON.parse(r.preview_totals_json) } catch { /* skip */ }
        let executeTotals: unknown = null
        if (r.execute_totals_json) {
          try { executeTotals = JSON.parse(r.execute_totals_json) } catch { /* skip */ }
        }
        const actor = r.actor_upn ?? "agent"
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
        if (r.status === "started") return [previewRow]
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
    const isAdmin = !!req.session?.isAdmin
    const viewerUpn = req.session?.upn ?? null
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
