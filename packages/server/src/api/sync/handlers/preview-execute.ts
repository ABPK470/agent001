/**
 * Sync preview / execute HTTP handlers — extracted from the god routes file.
 */

import type { AgentHost } from "@mia/agent"
import {
  isSyncPublishRequiredError,
  loadPlan,
  previewSync,
  PUBLISH_REQUIRED_CODE,
  type SyncExecuteResult,
} from "@mia/sync"
import type { FastifyInstance, FastifyReply } from "fastify"
import { cancelOperation } from "../../../infra/operations/cancel-registry.js"
import { decodePreviewBody } from "../decode-preview.js"
import {
  buildSyncAuditDetail,
  loadPersistedSyncPlanSummary,
  summarizeSyncPlan,
} from "../service/plan-summary.js"
import { rebuildLiveSyncEnvironments } from "../state/live-environments.js"
import {
  runRegisteredSyncExecute,
  SYNC_EXECUTE_OPERATION,
} from "../state/execute-session.js"
import { assertSyncHttpPolicy } from "../service/sync-http-policy.js"

export type PreviewExecuteDeps = {
  auditSync: (
    planId: string,
    actor: string,
    actorUpn: string | null,
    action: string,
    detail: Record<string, unknown>,
  ) => void
  syncExecuteAuditAction: (result: SyncExecuteResult) => string
  syncExecuteAuditDetail: (
    planDetail: Record<string, unknown>,
    result: SyncExecuteResult,
  ) => Record<string, unknown>
  replySyncPolicyError: (reply: FastifyReply, error: unknown) => Record<string, unknown> | null
}

export function registerPreviewExecuteRoutes(
  app: FastifyInstance,
  host: AgentHost,
  deps: PreviewExecuteDeps,
): void {
  const { auditSync, syncExecuteAuditAction, syncExecuteAuditDetail, replySyncPolicyError } = deps

  app.post("/api/sync/preview", async (req, reply) => {
    const actor = req.session.upn
    const actorUpn = req.session.upn
    const decoded = decodePreviewBody(req.body)
    if (!decoded.ok) {
      reply.code(400)
      return { error: decoded.error }
    }
    const body = decoded.value
    try {
      rebuildLiveSyncEnvironments(host)
      await assertSyncHttpPolicy({
        session: req.session,
        toolName: "sync_preview",
        args: {
          entityType: body.entityType,
          entityId: body.entityId,
          source: body.source,
          target: body.target,
          force: Boolean(body.force),
          enabledOptionalTables: body.enabledOptionalTables ?? [],
        },
      })
      const plan = await previewSync({
        host,
        entityType: body.entityType,
        entityId: body.entityId,
        source: body.source,
        target: body.target,
        force: Boolean(body.force),
        enabledOptionalTables: body.enabledOptionalTables,
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
              force: Boolean(body.force),
              enabledOptionalTables: body.enabledOptionalTables ?? [],
            }
          : {
              entityType: body.entityType,
              entityId: body.entityId,
              source: body.source,
              target: body.target,
              force: Boolean(body.force),
              enabledOptionalTables: body.enabledOptionalTables ?? [],
              totals: plan.totals,
            },
      )
      return plan
    } catch (error) {
      const policyBody = replySyncPolicyError(reply, error)
      if (policyBody) return policyBody
      if (isSyncPublishRequiredError(error)) {
        reply.code(409)
        return {
          error: error.message,
          code: PUBLISH_REQUIRED_CODE,
          entityType: error.entityType,
        }
      }
      const msg = error instanceof Error ? error.message : String(error)
      console.warn(`[sync.preview] failed for ${body.entityType} ${body.entityId}: ${msg}`)
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
      await assertSyncHttpPolicy({
        session: req.session,
        toolName: "sync_execute",
        args: {
          planId: req.params.planId,
          confirm: true,
          source: plan?.source,
          target: plan?.target,
          entityType: plan?.entity.type,
          entityId: plan?.entity.id,
        },
      })
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
        syncExecuteAuditDetail(planDetail, result),
      )
      if (result.outcome === "refused") {
        auditSync(req.params.planId, actor, actorUpn, "sync.execute.failed", {
          ...planDetail,
          error: result.error,
        })
        reply.code(400)
        return result
      }
      if (
        result.outcome === "completed" &&
        !result.success &&
        !result.skipped &&
        result.error !== "Cancelled by user"
      ) {
        reply.code(500)
      }
      return result
    } catch (error) {
      const policyBody = replySyncPolicyError(reply, error)
      if (policyBody) {
        auditSync(req.params.planId, actor, actorUpn, "sync.execute.failed", {
          ...planDetail,
          error: policyBody.error,
          code: policyBody.code,
        })
        return policyBody
      }
      if (isSyncPublishRequiredError(error)) {
        auditSync(req.params.planId, actor, actorUpn, "sync.execute.failed", {
          ...planDetail,
          error: error.message,
          code: PUBLISH_REQUIRED_CODE,
        })
        reply.code(409)
        return {
          error: error.message,
          code: PUBLISH_REQUIRED_CODE,
          entityType: error.entityType,
        }
      }
      const msg = error instanceof Error ? error.message : String(error)
      auditSync(req.params.planId, actor, actorUpn, "sync.execute.failed", {
        ...planDetail,
        error: msg,
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
}
