import { parseBoundaryJson } from "../../internal/parse-json.js"

/**
 * Policy transport routes.
 */

import { isPolicyEffect, PolicyEffect } from "@mia/agent"
import { EventType } from "@mia/shared-enums"
import type { FastifyInstance, FastifyRequest } from "fastify"
import * as db from "../../infra/persistence/sqlite.js"
import { broadcast } from "../../infra/events/broadcaster.js"
import { withBeforeAfter } from "../admin/audit-detail.js"

function audit(req: FastifyRequest, action: string, detail: Record<string, unknown>): void {
  try {
    db.saveAdminAudit({
      actor: req.session.upn,
      action,
      detail: JSON.stringify(detail),
      timestamp: new Date().toISOString(),
      scope_id: "policies"
    })
  } catch (error) {
    console.warn("[policies] audit_log write failed:", error instanceof Error ? error.message : error)
  }
}

function policyAuditSnapshot(rule: {
  name: string
  effect: string
  condition: string
  parameters?: string | null
  source?: string | null
}): Record<string, unknown> {
  return {
    name: rule.name,
    effect: rule.effect,
    condition: rule.condition,
    parameters: parseBoundaryJson(rule.parameters ?? "{}"),
    source: rule.source ?? null,
  }
}

export function registerPolicyRoutes(app: FastifyInstance): void {
  app.get("/api/policies", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    return db.listPolicyRules().map((rule) => ({
      name: rule.name,
      effect: rule.effect,
      condition: rule.condition,
      parameters: parseBoundaryJson(rule.parameters),
      source: rule.source ?? db.PolicySource.Db,
      createdAt: rule.created_at,
      updatedAt: rule.updated_at ?? null,
      updatedBy: rule.updated_by ?? null
    }))
  })

  app.post<{
    Body: { name: string; effect: string; condition: string; parameters?: Record<string, unknown> }
  }>("/api/policies", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    const { name, effect, condition, parameters } = req.body
    if (!name || !effect || !condition) {
      reply.code(400)
      return { error: "name, effect, and condition are required" }
    }
    if (!isPolicyEffect(effect)) {
      reply.code(400)
      return { error: "effect must be allow, require_approval, or deny" }
    }

    const existing = db.listPolicyRules().find((rule) => rule.name === name)
    const now = new Date().toISOString()
    db.savePolicyRule({
      name,
      effect: effect satisfies PolicyEffect,
      condition,
      parameters: JSON.stringify(parameters ?? {}),
      created_at: existing?.created_at ?? now,
      // Any operator create/update becomes `db` so boot will not overwrite it.
      source: db.PolicySource.Db,
      updated_at: now,
      updated_by: req.session.upn
    })

    const afterSnap = {
      name,
      effect,
      condition,
      parameters: parameters ?? {},
      source: db.PolicySource.Db,
    }
    audit(
      req,
      existing ? "policy.update" : "policy.create",
      existing
        ? withBeforeAfter({ name, effect, condition }, policyAuditSnapshot(existing), afterSnap)
        : withBeforeAfter({ name, effect, condition }, null, afterSnap),
    )
    broadcast({
      type: EventType.SyncPolicySaved,
      data: { name, effect, condition, actor: req.session.upn, created: !existing }
    })
    reply.code(existing ? 200 : 201)
    return { ok: true }
  })

  app.delete<{ Params: { name: string } }>("/api/policies/:name", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    const before = db.listPolicyRules().find((rule) => rule.name === req.params.name)
    db.deletePolicyRule(req.params.name)
    audit(
      req,
      "policy.delete",
      withBeforeAfter(
        { name: req.params.name, source: before?.source ?? null },
        before ? policyAuditSnapshot(before) : null,
        null,
      ),
    )
    broadcast({
      type: EventType.SyncPolicyDeleted,
      data: { name: req.params.name, actor: req.session.upn, source: before?.source ?? null }
    })
    return { ok: true }
  })
}
