/**
 * F1 — Reconciliation proposer routes.
 *
 *   GET    /api/proposer/runs                 list recent proposer runs
 *   POST   /api/proposer/run                  manually trigger a run
 *   GET    /api/proposer/proposals            list proposals (filter by status, risk, env-pair)
 *   GET    /api/proposer/proposals/:id        get one proposal (with annotation + history)
 *   POST   /api/proposer/proposals/:id/status transition a proposal (dismiss / snooze / etc.)
 *   GET    /api/proposer/schedules            list schedules
 *   POST   /api/proposer/schedules            upsert schedule
 *   DELETE /api/proposer/schedules/:tenant/:source/:target
 *                                             remove schedule
 *
 * Tenant resolution mirrors `entity-registry.ts`:
 *   ?tenant= (admin only) overrides the sentinel `_default` tenant.
 */

import type { AgentHost, LlmCompletionPort, ProposalStatus, RiskTier } from "@mia/agent"
import type { FastifyInstance, FastifyRequest } from "fastify"
import * as db from "../db/index.js"
import { runProposer } from "../proposer/runner.js"
import {
    deleteSchedule, listSchedules, upsertSchedule,
} from "../proposer/scheduler.js"

const DEFAULT_TENANT_ID = "_default"

function resolveTenant(req: FastifyRequest): string {
  const q = (req.query as Record<string, string> | undefined)?.["tenant"]
  if (q && req.session?.isAdmin) return q
  return DEFAULT_TENANT_ID
}

export interface ProposerRouteDeps {
  /** Server boot-host (shared mssql Map). Required for manual triggers. */
  host: AgentHost
  /** Injected so the runner can annotate without coupling routes to the LLM module. */
  getLlm?: () => LlmCompletionPort | null
}

export function registerProposerRoutes(app: FastifyInstance, deps: ProposerRouteDeps): void {

  // ── Runs ────────────────────────────────────────────────────
  app.get<{ Querystring: { tenant?: string; limit?: string } }>(
    "/api/proposer/runs",
    async (req) => {
      const tenantId = resolveTenant(req)
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50))
      return db.listProposerRuns(tenantId, limit)
    },
  )

  app.post<{ Body: { source: string; target: string } }>(
    "/api/proposer/run",
    async (req, reply) => {
      if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
      const { source, target } = req.body
      if (!source || !target) { reply.code(400); return { error: "source and target are required" } }
      try {
        const tenantId = resolveTenant(req)
        const result = await runProposer(deps.host, { source, target }, {
          tenantId,
          triggeredBy: req.session.upn,
          trigger:     "manual",
          llm:         deps.getLlm?.() ?? null,
        })
        return result
      } catch (e) {
        reply.code(400)
        return { error: e instanceof Error ? e.message : String(e) }
      }
    },
  )

  // ── Proposals ───────────────────────────────────────────────
  app.get<{ Querystring: {
    tenant?: string; status?: string; riskTier?: string;
    source?: string; target?: string; limit?: string;
  } }>("/api/proposer/proposals", async (req) => {
    const tenantId = resolveTenant(req)
    const rows = db.listProposals({
      tenantId,
      status:    req.query.status?.split(",") as ProposalStatus[] | undefined,
      riskTier:  req.query.riskTier?.split(",") as RiskTier[] | undefined,
      source:    req.query.source,
      target:    req.query.target,
      limit:     Math.min(1000, Math.max(1, Number(req.query.limit) || 200)),
    })
    return rows.map(materialiseProposal)
  })

  app.get<{ Params: { id: string } }>(
    "/api/proposer/proposals/:id",
    async (req, reply) => {
      const row = db.getProposal(req.params.id)
      if (!row) { reply.code(404); return { error: "proposal not found" } }
      return {
        ...materialiseProposal(row),
        history: db.listProposalHistory(req.params.id),
      }
    },
  )

  app.post<{ Params: { id: string }; Body: {
    to:           ProposalStatus
    reason?:      string
    planId?:      string
    snoozeUntil?: string
    supersededBy?: string
  } }>("/api/proposer/proposals/:id/status", async (req, reply) => {
    try {
      const r = db.updateProposalStatus({
        id:           req.params.id,
        to:           req.body.to,
        actor:        req.session.upn,
        reason:       req.body.reason,
        planId:       req.body.planId,
        snoozeUntil:  req.body.snoozeUntil,
        supersededBy: req.body.supersededBy,
      })
      return materialiseProposal(r)
    } catch (e) {
      reply.code(400)
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ── Schedules ───────────────────────────────────────────────
  app.get<{ Querystring: { tenant?: string } }>(
    "/api/proposer/schedules",
    async (req) => listSchedules(resolveTenant(req)),
  )

  app.post<{ Body: {
    source: string; target: string; cron: string; enabled?: boolean
  } }>("/api/proposer/schedules", async (req, reply) => {
    if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
    try {
      return upsertSchedule({
        tenantId: resolveTenant(req),
        source:   req.body.source,
        target:   req.body.target,
        cron:     req.body.cron,
        enabled:  req.body.enabled !== false,
        actor:    req.session.upn,
      })
    } catch (e) {
      reply.code(400)
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  app.delete<{ Params: { tenant: string; source: string; target: string } }>(
    "/api/proposer/schedules/:tenant/:source/:target",
    async (req, reply) => {
      if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
      deleteSchedule(req.params.tenant, req.params.source, req.params.target)
      return { ok: true }
    },
  )
}

function materialiseProposal(row: db.ProposalRow): Record<string, unknown> {
  return {
    ...row,
    counts:     db.parseCounts(row),
    annotation: db.parseAnnotation(row),
  }
}
