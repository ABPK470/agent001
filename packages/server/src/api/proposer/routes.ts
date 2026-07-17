/**
 * Reconciliation proposer transport routes.
 */

import type { AgentHost } from "@mia/agent"
import { EventType } from "@mia/shared-enums"
import type { LlmCompletionPort, ProposalStatus, RiskTier } from "@mia/sync"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { broadcast } from "../../infra/events/broadcaster.js"
import * as db from "../../infra/persistence/sqlite.js"
import { runProposer } from "./application/runner.js"
import { cancelOperation } from "../../infra/operations/cancel-registry.js"
import { clearLlmInteractionForOperation } from "../../infra/llm/operation-context.js"
import { deleteSchedule, listSchedules, upsertSchedule } from "./runtime/scheduler.js"

const DEFAULT_TENANT_ID = "_default"

function resolveTenant(req: FastifyRequest): string {
  const q = (req.query as Record<string, string> | undefined)?.["tenant"]
  if (q && req.session?.isAdmin) return q
  return DEFAULT_TENANT_ID
}

export interface ProposerRouteDeps {
  host: AgentHost
  getLlm?: () => LlmCompletionPort | null
}

export function registerProposerRoutes(app: FastifyInstance, deps: ProposerRouteDeps): void {
  app.get<{ Querystring: { tenant?: string; limit?: string } }>("/api/proposer/runs", async (req) => {
    const tenantId = resolveTenant(req)
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50))
    return db.listProposerRuns(tenantId, limit)
  })

  app.post<{ Body: { source: string; target: string } }>("/api/proposer/run", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    const { source, target } = req.body
    if (!source || !target) {
      reply.code(400)
      return { error: "source and target are required" }
    }
    const tenantId = resolveTenant(req)
    const envPair = { source, target }
    const runId = db.createProposerRun({
      tenantId,
      source,
      target,
      triggeredBy: req.session.upn,
      trigger: "manual",
    })
    const options = {
      tenantId,
      triggeredBy: req.session.upn,
      trigger: "manual" as const,
      llm: deps.getLlm?.() ?? null,
      runId,
    }

    void runProposer(deps.host, envPair, options).catch((error) => {
      const msg = error instanceof Error ? error.message : String(error)
      console.error(`[proposer] manual run failed (${source} → ${target}):`, msg)
    })

    reply.code(202)
    return { accepted: true, source, target, runId }
  })

  app.post<{ Params: { id: string } }>("/api/proposer/runs/:id/cancel", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    const runId = req.params.id
    const row = db.getProposerRun(runId)
    if (!row || (row.status !== "running" && row.status !== "pending")) {
      reply.code(404)
      return { error: "No active run to cancel" }
    }

    const aborted = cancelOperation("proposer.run", runId)
    clearLlmInteractionForOperation("proposer.run", runId)
    if (!aborted) {
      db.finishProposerRun({
        id: runId,
        status: "cancelled",
        counts: { scanned: row.scanned, produced: row.produced, errors: row.errors },
        durationMs: row.duration_ms ?? 0,
        error: "Cancelled by user",
      })
      broadcast({
        type: EventType.SyncProposerRunCancelled,
        data: {
          runId,
          envPair: { source: row.source, target: row.target },
          reason: "Cancelled by user",
        },
      })
    }
    return { cancelled: true, runId }
  })

  app.get<{
    Querystring: {
      tenant?: string
      status?: string
      riskTier?: string
      source?: string
      target?: string
      limit?: string
    }
  }>("/api/proposer/proposals", async (req) => {
    const tenantId = resolveTenant(req)
    const rows = db.listProposals({
      tenantId,
      status: req.query.status?.split(",") as ProposalStatus[] | undefined,
      riskTier: req.query.riskTier?.split(",") as RiskTier[] | undefined,
      source: req.query.source,
      target: req.query.target,
      limit: Math.min(1000, Math.max(1, Number(req.query.limit) || 200))
    })
    return rows.map(materialiseProposal)
  })

  app.get<{ Params: { id: string } }>("/api/proposer/proposals/:id", async (req, reply) => {
    const row = db.getProposal(req.params.id)
    if (!row) {
      reply.code(404)
      return { error: "proposal not found" }
    }
    return { ...materialiseProposal(row), history: db.listProposalHistory(req.params.id) }
  })

  app.post<{
    Params: { id: string }
    Body: {
      to: ProposalStatus
      reason?: string
      planId?: string
      snoozeUntil?: string
      supersededBy?: string
    }
  }>("/api/proposer/proposals/:id/status", async (req, reply) => {
    try {
      const before = db.getProposal(req.params.id)
      if (!before) {
        reply.code(404)
        return { error: "proposal not found" }
      }
      const row = db.updateProposalStatus({
        id: req.params.id,
        to: req.body.to,
        actor: req.session.upn,
        reason: req.body.reason,
        planId: req.body.planId,
        snoozeUntil: req.body.snoozeUntil,
        supersededBy: req.body.supersededBy
      })
      broadcast({
        type: EventType.SyncProposalStatusChanged,
        data: { id: row.id, from: before.status, to: row.status, actor: req.session.upn }
      })
      return materialiseProposal(row)
    } catch (error) {
      reply.code(400)
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })

  app.get<{ Querystring: { tenant?: string } }>("/api/proposer/schedules", async (req) =>
    listSchedules(resolveTenant(req))
  )
  app.post<{ Body: { source: string; target: string; cron: string; enabled?: boolean } }>(
    "/api/proposer/schedules",
    async (req, reply) => {
      if (!req.session?.isAdmin) {
        reply.code(403)
        return { error: "admin only" }
      }
      try {
        const row = upsertSchedule({
          tenantId: resolveTenant(req),
          source: req.body.source,
          target: req.body.target,
          cron: req.body.cron,
          enabled: req.body.enabled !== false,
          actor: req.session.upn
        })
        broadcast({
          type: EventType.SyncProposerScheduleSaved,
          data: {
            tenantId: row.tenant_id,
            source: row.source,
            target: row.target,
            enabled: row.enabled,
            actor: req.session.upn
          }
        })
        return row
      } catch (error) {
        reply.code(400)
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }
  )
  app.delete<{ Params: { tenant: string; source: string; target: string } }>(
    "/api/proposer/schedules/:tenant/:source/:target",
    async (req, reply) => {
      if (!req.session?.isAdmin) {
        reply.code(403)
        return { error: "admin only" }
      }
      deleteSchedule(req.params.tenant, req.params.source, req.params.target)
      broadcast({
        type: EventType.SyncProposerScheduleDeleted,
        data: {
          tenantId: req.params.tenant,
          source: req.params.source,
          target: req.params.target,
          actor: req.session.upn
        }
      })
      return { ok: true }
    }
  )
}

function materialiseProposal(row: db.ProposalRow): Record<string, unknown> {
  return {
    ...row,
    created_at: row.enqueued_at,
    finding_kind: row.kind,
    counts: db.parseCounts(row),
    annotation: db.parseAnnotation(row),
  }
}
