/**
 * Sync transport routes.
 */

import { type AgentHost } from "@mia/agent"
import { EventType, isSyncRunStatus, type SyncRunStatus } from "@mia/shared-enums"
import type { AuthoredSyncFlowStep } from "@mia/shared-types"
import {
  getEnvironments,
  listPublishedSyncDefinitions,
  loadPlan,
  loadPublishedSyncDefinitionBundle,
  previewSync,
  searchEntities,
  type EntityType,
  type ExecuteProgress
} from "@mia/sync"
import type { FastifyInstance, FastifyReply } from "fastify"
import { broadcast } from "../../platform/events/broadcaster.js"
import { cancelOperation } from "../../platform/operations/cancel-registry.js"
import { PUBLISHED_SYNC_BUNDLE_PATH } from "../../bootstrap/published-sync-bundle.js"
import * as db from "../../platform/persistence/sqlite.js"
import {
  listSyncDefinitionAdminItems,
  listSyncDefinitionRuntimeOptions,
  defaultEntityFlowId,
  PublishSyncDefinitionsError,
  publishSyncDefinitionsFromDb,
  resetSyncDefinitionConfig,
  upsertSyncDefinitionConfig
} from "./application/definitions.js"
import {
  buildSyncAuditDetail,
  loadPersistedSyncPlanSummary,
  summarizeSyncPlan
} from "./application/plan-summary.js"
import { rebuildLiveSyncEnvironments } from "./runtime/live-environments.js"
import { registerSyncMetadataRoutes } from "./transport/sync-metadata-routes.js"
import {
  runRegisteredSyncExecute,
  SYNC_EXECUTE_OPERATION,
} from "./runtime/execute-session.js"

interface PublishSyncDefinitionsResponse {
  publishedAt: string
  publishedVersion: string
  definitionCount: number
  publishedBundlePath: string
  stdout: string[]
  stderr: string[]
}

interface PreviewBody {
  entityType: EntityType
  entityId: string | number
  source: string
  target: string
  force?: boolean
  enabledOptionalTables?: string[]
}

function sanitiseDefinitionConfig(body: Record<string, unknown>):
  | {
      flowTemplateId?: string
      serviceProfileRef?: string
      environmentPolicyRef?: string
      ownershipTeam?: string
      ownershipOwner?: string | null
      reviewStatus?: "legacy-review-required" | "reviewed"
      ownershipNotes?: string[]
    }
  | string {
  if (body["executionSteps"] !== undefined) {
    return "executionSteps are defined on flows in Sync metadata — set flowTemplateId only"
  }
  const out: {
    flowTemplateId?: string
    serviceProfileRef?: string
    environmentPolicyRef?: string
    ownershipTeam?: string
    ownershipOwner?: string | null
    reviewStatus?: "legacy-review-required" | "reviewed"
    ownershipNotes?: string[]
  } = {}
  for (const field of [
    "flowTemplateId",
    "serviceProfileRef",
    "environmentPolicyRef",
    "ownershipTeam"
  ] as const) {
    if (body[field] !== undefined) {
      if (typeof body[field] !== "string" || body[field].trim() === "")
        return `${field} must be a non-empty string`
      out[field] = body[field].trim()
    }
  }

  if (body["ownershipOwner"] !== undefined) {
    if (body["ownershipOwner"] !== null && typeof body["ownershipOwner"] !== "string")
      return "ownershipOwner must be null or a string"
    out.ownershipOwner = typeof body["ownershipOwner"] === "string" ? body["ownershipOwner"].trim() : null
  }
  if (body["reviewStatus"] !== undefined) {
    if (body["reviewStatus"] !== "legacy-review-required" && body["reviewStatus"] !== "reviewed")
      return "reviewStatus must be legacy-review-required or reviewed"
    out.reviewStatus = body["reviewStatus"]
  }
  if (body["ownershipNotes"] !== undefined) {
    if (!Array.isArray(body["ownershipNotes"])) return "ownershipNotes must be an array"
    out.ownershipNotes = (body["ownershipNotes"] as unknown[]).map(String)
  }
  return out
}

function asRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`)
  return value.trim()
}

function auditSync(
  planId: string,
  actor: string,
  actorUpn: string | null,
  action: string,
  detail: Record<string, unknown>
): void {
  try {
    db.recordSyncAudit({ planId, actor, actorUpn, action, detail })
  } catch (error) {
    console.error("auditSync failed:", error instanceof Error ? error.message : error)
  }
}

const SYNC_HISTORY_SORTS = ["started_desc", "started_asc", "finished_desc", "finished_asc"] as const
type SyncHistorySort = (typeof SYNC_HISTORY_SORTS)[number]

function parseSyncHistoryStatuses(raw: string | undefined): SyncRunStatus[] | undefined {
  if (!raw?.trim()) return undefined
  const statuses = raw
    .split(",")
    .map((value) => value.trim())
    .filter(isSyncRunStatus)
  return statuses.length > 0 ? statuses : undefined
}

function parseSyncHistorySort(raw: string | undefined): SyncHistorySort {
  if (raw && (SYNC_HISTORY_SORTS as readonly string[]).includes(raw)) {
    return raw as SyncHistorySort
  }
  return "started_desc"
}

function parseSyncHistoryQuery(
  query: {
    page?: string
    pageSize?: string
    q?: string
    status?: string
    entityType?: string
    actorUpn?: string
    source?: string
    target?: string
    from?: string
    to?: string
    sort?: string
  },
  viewerUpn: string | undefined,
  isAdmin: boolean
): db.ListSyncRunsPaginatedInput {
  const page = Math.max(1, Number(query.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 25))
  const actorUpn = isAdmin ? query.actorUpn?.trim() || undefined : viewerUpn
  return {
    page,
    pageSize,
    actorUpn,
    search: query.q?.trim() || undefined,
    status: parseSyncHistoryStatuses(query.status),
    entityType: query.entityType?.trim() || undefined,
    source: query.source?.trim() || undefined,
    target: query.target?.trim() || undefined,
    startedAfter: query.from?.trim() || undefined,
    startedBefore: query.to?.trim() || undefined,
    sort: parseSyncHistorySort(query.sort)
  }
}

function syncExecuteAuditAction(result: {
  success: boolean
  skipped?: boolean
  error?: string
}): string {
  if (result.skipped) return "sync.execute.skipped"
  if (result.success) return "sync.execute.completed"
  if (result.error === "Cancelled by user") return "sync.execute.cancelled"
  return "sync.execute.failed"
}

function mapSyncRunRow(row: db.SyncRunRow) {
  const previewTotals = {
    insert: row.preview_inserts,
    update: row.preview_updates,
    delete: row.preview_deletes
  }
  const executeTotals =
    row.executed_inserts === null
      ? null
      : {
          insert: row.executed_inserts,
          update: row.executed_updates,
          delete: row.executed_deletes
        }
  return {
    planId: row.plan_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    entityDisplayName: row.entity_display_name,
    source: row.source,
    target: row.target,
    actorUpn: row.actor_upn,
    status: row.status,
    error: row.error,
    previewTotals,
    executeTotals,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    planAvailable: Boolean(db.getSyncRunPlanJson(row.plan_id))
  }
}

export function registerSyncRoutes(app: FastifyInstance, projectRoot: string, host: AgentHost): void {
  app.get("/api/sync/environments", async () => {
    rebuildLiveSyncEnvironments(host)
    return getEnvironments(host)
  })
  app.get("/api/sync/definitions", async () => listPublishedSyncDefinitions(host, projectRoot))
  app.get<{ Params: { entityId: string } }>(
    "/api/sync/definitions/:entityId/published-bundle",
    async (req, reply) => {
      try {
        const bundle = loadPublishedSyncDefinitionBundle(host, projectRoot)
        const definition = bundle.definitions[req.params.entityId]
        if (!definition) {
          reply.code(404)
          return { error: `No published definition for "${req.params.entityId}" in ${PUBLISHED_SYNC_BUNDLE_PATH}` }
        }
        return {
          bundlePath: PUBLISHED_SYNC_BUNDLE_PATH,
          bundlePublishedAt: bundle.publishedAt,
          bundlePublishedVersion: bundle.publishedVersion,
          definition
        }
      } catch (error) {
        reply.code(404)
        return {
          error: error instanceof Error ? error.message : String(error),
          bundlePath: PUBLISHED_SYNC_BUNDLE_PATH
        }
      }
    }
  )
  app.get("/api/sync-definition-configs", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    return listSyncDefinitionAdminItems(projectRoot)
  })
  app.get("/api/sync-definition-config-options", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    return listSyncDefinitionRuntimeOptions(projectRoot)
  })
  app.put<{ Params: { entityId: string }; Body: Record<string, unknown> }>(
    "/api/sync-definition-configs/:entityId",
    async (req, reply) => {
      if (!req.session?.isAdmin) {
        reply.code(403)
        return { error: "admin only" }
      }
      const entity = db.getEntityDefinition("_default", req.params.entityId)
      if (!entity) {
        reply.code(404)
        return { error: `unknown entity \"${req.params.entityId}\"` }
      }
      const sanitised = sanitiseDefinitionConfig(req.body ?? {})
      if (typeof sanitised === "string") {
        reply.code(400)
        return { error: sanitised }
      }
      const runtimeOptions = listSyncDefinitionRuntimeOptions(projectRoot)
      if (
        sanitised.flowTemplateId !== undefined &&
        !runtimeOptions.flowTemplates.some((option) => option.id === sanitised.flowTemplateId)
      ) {
        reply.code(400)
        return { error: `unknown flowTemplateId "${sanitised.flowTemplateId}"` }
      }
      if (
        sanitised.serviceProfileRef !== undefined &&
        !runtimeOptions.serviceProfiles.some((option) => option.id === sanitised.serviceProfileRef)
      ) {
        reply.code(400)
        return { error: `unknown serviceProfileRef "${sanitised.serviceProfileRef}"` }
      }
      if (
        sanitised.environmentPolicyRef !== undefined &&
        !runtimeOptions.environmentPolicies.some((option) => option.id === sanitised.environmentPolicyRef)
      ) {
        reply.code(400)
        return { error: `unknown environmentPolicyRef "${sanitised.environmentPolicyRef}"` }
      }
      const existing = db.getSyncDefinitionConfig("_default", req.params.entityId)
      const flowId =
        sanitised.flowTemplateId ?? existing?.flow_preset ?? defaultEntityFlowId(projectRoot, req.params.entityId)
      if (!flowId) {
        reply.code(400)
        return { error: "flowTemplateId is required" }
      }
      upsertSyncDefinitionConfig(projectRoot, {
        tenant_id: "_default",
        entity_id: req.params.entityId,
        flow_preset: flowId,
        execution_steps_json: "[]",
        service_profile_ref: sanitised.serviceProfileRef ?? existing?.service_profile_ref ?? "default",
        environment_policy_ref:
          sanitised.environmentPolicyRef ?? existing?.environment_policy_ref ?? "default",
        ownership_team: sanitised.ownershipTeam ?? existing?.ownership_team ?? "sync-platform",
        ownership_owner: sanitised.ownershipOwner ?? existing?.ownership_owner ?? null,
        review_status: sanitised.reviewStatus ?? existing?.review_status ?? "legacy-review-required",
        ownership_notes_json: JSON.stringify(
          sanitised.ownershipNotes ??
            (existing ? (JSON.parse(existing.ownership_notes_json) as string[]) : [])
        ),
        updated_at: new Date().toISOString(),
        updated_by: req.session.upn
      })
      broadcast({
        type: EventType.SyncDefinitionsPublished,
        data: { action: "config-updated", entityId: req.params.entityId, actor: req.session.upn }
      })
      return { ok: true }
    }
  )
  app.delete<{ Params: { entityId: string } }>(
    "/api/sync-definition-configs/:entityId",
    async (req, reply) => {
      if (!req.session?.isAdmin) {
        reply.code(403)
        return { error: "admin only" }
      }
      const reset = resetSyncDefinitionConfig(projectRoot, "_default", req.params.entityId)
      if (!reset) {
        reply.code(404)
        return { error: `unknown entity \"${req.params.entityId}\"` }
      }
      broadcast({
        type: EventType.SyncDefinitionsPublished,
        data: { action: "config-reset", entityId: req.params.entityId, actor: req.session.upn }
      })
      return { ok: true }
    }
  )
  app.post(
    "/api/sync/definitions/publish",
    async (
      req,
      reply
    ): Promise<PublishSyncDefinitionsResponse | { error: string; stdout?: string[]; stderr?: string[] }> => {
      if (!req.session?.isAdmin) {
        reply.code(403)
        return { error: "admin only" }
      }

      try {
        const result = publishSyncDefinitionsFromDb(projectRoot)
        db.saveAdminAudit({
          actor: req.session.upn,
          action: "sync.definitions.published",
          detail: JSON.stringify({
            publishedAt: result.publishedAt,
            publishedVersion: result.publishedVersion,
            definitionCount: result.definitionCount
          }),
          timestamp: new Date().toISOString(),
          scope_id: "sync-definitions"
        })
        broadcast({
          type: EventType.SyncDefinitionsPublished,
          data: {
            action: "published",
            publishedAt: result.publishedAt,
            publishedVersion: result.publishedVersion,
            definitionCount: result.definitionCount,
            actor: req.session.upn
          }
        })
        return result
      } catch (error) {
        reply.code(400)
        return {
          error: error instanceof Error ? error.message : String(error),
          stdout: [],
          stderr: error instanceof PublishSyncDefinitionsError ? error.stderr : [],
        }
      }
    }
  )
  app.get<{ Querystring: { entityType: string; source: string; q: string; limit?: string; mode?: string } }>(
    "/api/sync/search",
    async (req, reply) => {
      rebuildLiveSyncEnvironments(host)
      const { entityType, source, q, limit, mode } = req.query
      if (!entityType || !source || !q) {
        reply.code(400)
        return { error: "entityType, source, and q are required" }
      }
      const searchMode = mode === "id" ? "id" : "name"
      try {
        return await searchEntities(
          host,
          entityType as EntityType,
          source,
          q,
          limit ? Number(limit) : 200,
          searchMode
        )
      } catch (error) {
        reply.code(400)
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  app.post<{ Body: PreviewBody }>("/api/sync/preview", async (req, reply) => {
    const actor = req.session.upn
    const actorUpn = req.session.upn
    try {
      rebuildLiveSyncEnvironments(host)
      const plan = await previewSync({
        host,
        entityType: req.body.entityType,
        entityId: req.body.entityId,
        source: req.body.source,
        target: req.body.target,
        force: Boolean(req.body.force),
        enabledOptionalTables: Array.isArray(req.body.enabledOptionalTables)
          ? req.body.enabledOptionalTables
          : undefined,
        userUpn: actorUpn,
      })
      const planSummary = summarizeSyncPlan(plan)
      auditSync(
        plan.planId,
        actor,
        actorUpn,
        "sync.preview",
        planSummary
          ? {
              ...buildSyncAuditDetail(planSummary, plan.totals),
              force: Boolean(req.body.force),
              enabledOptionalTables: Array.isArray(req.body.enabledOptionalTables)
                ? req.body.enabledOptionalTables
                : []
            }
          : {
              entityType: req.body.entityType,
              entityId: req.body.entityId,
              source: req.body.source,
              target: req.body.target,
              force: Boolean(req.body.force),
              enabledOptionalTables: Array.isArray(req.body.enabledOptionalTables)
                ? req.body.enabledOptionalTables
                : [],
              totals: plan.totals
            }
      )
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
      const result = await runRegisteredSyncExecute({
        host,
        planId: req.params.planId,
        userUpn: actor,
      })
      auditSync(
        req.params.planId,
        actor,
        actorUpn,
        syncExecuteAuditAction(result),
        { ...planDetail, error: result.error ?? result.message ?? null, skipped: result.skipped ?? false }
      )
      if (!result.success && !result.skipped && result.error !== "Cancelled by user") reply.code(500)
      return result
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      auditSync(req.params.planId, actor, actorUpn, "sync.execute.failed", {
        ...planDetail,
        error: msg
      })
      reply.code(400)
      return { error: msg }
    }
  })

  app.post<{ Params: { planId: string } }>("/api/sync/execute/:planId/cancel", async (req, reply) => {
    const planId = req.params.planId
    const cancelled = cancelOperation(SYNC_EXECUTE_OPERATION, planId)
    if (!cancelled) {
      reply.code(404)
      return { error: "No active execute to cancel" }
    }
    return { cancelled: true, planId }
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
    let clientClosed = false
    req.raw.on("close", () => {
      clientClosed = true
      clearInterval(heartbeat)
      cancelOperation(SYNC_EXECUTE_OPERATION, req.params.planId, "Client disconnected")
    })
    try {
      const result = await runRegisteredSyncExecute({
        host,
        planId: req.params.planId,
        userUpn: actor,
        onProgress: send,
      })
      if (!clientClosed) {
        auditSync(
          req.params.planId,
          actor,
          actorUpn,
          syncExecuteAuditAction(result),
          { ...planDetail, error: result.error ?? result.message ?? null, skipped: result.skipped ?? false }
        )
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (!clientClosed) {
        send({ type: "failed", error: msg })
        auditSync(req.params.planId, actor, actorUpn, "sync.execute.failed", {
          ...planDetail,
          error: msg
        })
      }
    } finally {
      clearInterval(heartbeat)
      reply.raw.end()
    }
  })

  app.get<{
    Querystring: {
      page?: string
      pageSize?: string
      q?: string
      status?: string
      entityType?: string
      actorUpn?: string
      source?: string
      target?: string
      from?: string
      to?: string
      sort?: string
    }
  }>("/api/sync/history", async (req) => {
    const isAdmin = !!req.session.isAdmin
    const viewerUpn = req.session.upn
    const filters = parseSyncHistoryQuery(req.query, viewerUpn, isAdmin)
    const total = db.countSyncRuns(filters)
    const rows = db.listSyncRunsPaginated(filters)
    const totalPages = total === 0 ? 0 : Math.ceil(total / filters.pageSize)
    return {
      items: rows.map(mapSyncRunRow),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
      totalPages
    }
  })

  app.get<{ Params: { planId: string } }>("/api/sync/history/:planId", async (req, reply) => {
    const isAdmin = !!req.session.isAdmin
    const viewerUpn = req.session.upn
    const row = db.getSyncRun(req.params.planId)
    if (!row) {
      reply.code(404)
      return { error: `Sync run ${req.params.planId} not found` }
    }
    if (!isAdmin && viewerUpn && row.actor_upn !== viewerUpn) {
      reply.code(403)
      return { error: "forbidden" }
    }
    const audit = db.listSyncAuditForPlan(req.params.planId).map((entry) => {
      let detail: unknown = null
      try {
        detail = JSON.parse(entry.detail)
      } catch {
        detail = entry.detail
      }
      const ts =
        entry.timestamp.includes("T") || entry.timestamp.endsWith("Z")
          ? entry.timestamp
          : entry.timestamp.replace(" ", "T") + "Z"
      return {
        action: entry.action,
        actor: entry.actor,
        actorUpn: entry.actor_upn,
        timestamp: ts,
        detail
      }
    })
    return { run: mapSyncRunRow(row), audit }
  })

  app.get<{
    Params: { planId: string }
    Querystring: { limit?: string; offset?: string }
  }>("/api/sync/history/:planId/sql-trace", async (req, reply) => {
    const isAdmin = !!req.session.isAdmin
    const viewerUpn = req.session.upn
    const row = db.getSyncRun(req.params.planId)
    if (!row) {
      reply.code(404)
      return { error: `Sync run ${req.params.planId} not found` }
    }
    if (!isAdmin && viewerUpn && row.actor_upn !== viewerUpn) {
      reply.code(403)
      return { error: "forbidden" }
    }
    const limit = Math.min(Number(req.query.limit) || 500, 2000)
    const offset = Math.max(Number(req.query.offset) || 0, 0)
    const items = db.listSyncSqlLogByPlan(req.params.planId, { limit, offset })
    return {
      planId: req.params.planId,
      count: items.length,
      total: db.countSyncSqlLogByPlan(req.params.planId),
      items: items.map((entry) => ({
        id: entry.id,
        planId: entry.plan_id,
        previewId: entry.preview_id,
        eventType: entry.event_type,
        scope: entry.scope,
        label: entry.label,
        connection: entry.connection,
        durationMs: entry.duration_ms,
        rowCount: entry.row_count,
        error: entry.error,
        createdAt: entry.created_at,
        sqlPreview: entry.sql_text.length > 2000
          ? entry.sql_text.slice(0, 2000) + `… [+${entry.sql_text.length - 2000} chars]`
          : entry.sql_text,
        sqlLength: entry.sql_text.length,
      })),
    }
  })

  app.get<{ Querystring: { limit?: string } }>("/api/sync/runs", async (req) => {
    const isAdmin = !!req.session.isAdmin
    const viewerUpn = req.session.upn
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25))
    return db
      .listSyncRuns(limit)
      .filter((row) => isAdmin || (viewerUpn && row.actor_upn === viewerUpn))
      .map(mapSyncRunRow)
  })

  registerSyncMetadataRoutes(app)
}

function setupSse(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  })
}
