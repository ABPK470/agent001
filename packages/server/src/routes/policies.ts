/**
 * Policy rules API routes — manage governance policies (admin only).
 *
 * Every rule the engine actually evaluates lives in `policy_rules`,
 * tagged with provenance via `source`:
 *   - `db`             — operator-authored.
 *   - `hosted_default` — seeded from `hostedDefaultPolicyRules()`.
 *   - `env_derived`    — derived from per-env config.
 *
 * Operators can edit/delete any rule. The seeder only re-creates a rule
 * if its `name` is missing, so deletes are persistent and edits survive
 * server restart.
 */

import { isPolicyEffect, PolicyEffect } from "@mia/agent"
import type { FastifyInstance, FastifyRequest } from "fastify"
import * as db from "../db/index.js"

function audit(req: FastifyRequest, action: string, detail: Record<string, unknown>): void {
  // Admin governance changes are not agent runs; persist them as
  // admin-scoped audit entries instead of faking a run row.
  try {
    db.saveAdminAudit({
      actor:     req.session.upn,
      action,
      detail:    JSON.stringify(detail),
      timestamp: new Date().toISOString(),
      scope_id:  "policies",
    })
  } catch (e) {
    console.warn("[policies] audit_log write failed:", e instanceof Error ? e.message : e)
  }
}

export function registerPolicyRoutes(app: FastifyInstance): void {
  // List every active policy rule with provenance (admin only).
  app.get("/api/policies", async (req, reply) => {
    if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
    return db.listPolicyRules().map((r) => ({
      name:       r.name,
      effect:     r.effect,
      condition:  r.condition,
      parameters: JSON.parse(r.parameters),
      source:     r.source ?? db.PolicySource.Db,
      createdAt:  r.created_at,
      updatedAt:  r.updated_at ?? null,
      updatedBy:  r.updated_by ?? null,
    }))
  })

  // Create or update a policy rule (admin only). Editing a seeded rule
  // preserves its source tag so the UI can show "you've edited a default".
  app.post<{
    Body: { name: string; effect: string; condition: string; parameters?: Record<string, unknown> }
  }>("/api/policies", async (req, reply) => {
    if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
    const { name, effect, condition, parameters } = req.body
    if (!name || !effect || !condition) {
      reply.code(400)
      return { error: "name, effect, and condition are required" }
    }
    if (!isPolicyEffect(effect)) {
      reply.code(400)
      return { error: "effect must be allow, require_approval, or deny" }
    }

    const existing = db.listPolicyRules().find((r) => r.name === name)
    const now = new Date().toISOString()
    db.savePolicyRule({
      name,
      effect:     effect satisfies PolicyEffect,
      condition,
      parameters: JSON.stringify(parameters ?? {}),
      created_at: existing?.created_at ?? now,
      source:     existing?.source ?? db.PolicySource.Db,
      updated_at: now,
      updated_by: req.session.upn,
    })

    audit(req, existing ? "policy.update" : "policy.create", { name, effect, condition })
    reply.code(existing ? 200 : 201)
    return { ok: true }
  })

  // Delete a policy rule (admin only). Caveat: the seeder will recreate
  // hosted_default / env_derived rules on next boot. To suppress a
  // default permanently, edit its `effect` instead of deleting it.
  app.delete<{ Params: { name: string } }>(
    "/api/policies/:name",
    async (req, reply) => {
      if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
      const before = db.listPolicyRules().find((r) => r.name === req.params.name)
      db.deletePolicyRule(req.params.name)
      audit(req, "policy.delete", { name: req.params.name, source: before?.source ?? null })
      return { ok: true }
    },
  )
}
