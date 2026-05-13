/**
 * Policy rules API routes — manage governance policies.
 */

import type { FastifyInstance } from "fastify"
import * as db from "../db.js"

export function registerPolicyRoutes(app: FastifyInstance): void {
  // List all policy rules (admin only — policies govern hosted-agent capability).
  app.get("/api/policies", async (req, reply) => {
    if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
    const rules = db.listPolicyRules()
    return rules.map((r) => ({
      name: r.name,
      effect: r.effect,
      condition: r.condition,
      parameters: JSON.parse(r.parameters),
      createdAt: r.created_at,
    }))
  })

  // Create or update a policy rule (admin only).
  app.post<{
    Body: { name: string; effect: string; condition: string; parameters?: Record<string, unknown> }
  }>("/api/policies", async (req, reply) => {
    if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
    const { name, effect, condition, parameters } = req.body
    if (!name || !effect || !condition) {
      reply.code(400)
      return { error: "name, effect, and condition are required" }
    }
    if (!["allow", "require_approval", "deny"].includes(effect)) {
      reply.code(400)
      return { error: "effect must be allow, require_approval, or deny" }
    }

    db.savePolicyRule({
      name,
      effect,
      condition,
      parameters: JSON.stringify(parameters ?? {}),
      created_at: new Date().toISOString(),
    })

    reply.code(201)
    return { ok: true }
  })

  // Delete a policy rule (admin only).
  app.delete<{ Params: { name: string } }>(
    "/api/policies/:name",
    async (req, reply) => {
      if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
      db.deletePolicyRule(req.params.name)
      return { ok: true }
    },
  )
}
