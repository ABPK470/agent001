/**
 * Layouts API routes — save/load dashboard configurations.
 */

import type { FastifyInstance } from "fastify"
import { randomUUID } from "node:crypto"
import * as db from "../db/index.js"

/**
 * Per-user well-known dashboard ID.
 *
 * v19: every request has a verified upn (gated by identity.ts onRequest
 * 401), so the dashboard key is always `dashboard:<upn>` — no admin
 * special-case, no sid fallback, no shared bucket. One input → one key.
 */
function dashboardIdFor(req: { session: { upn: string } }): string {
  return `dashboard:${req.session.upn.toLowerCase()}`
}

export function registerLayoutRoutes(app: FastifyInstance): void {

  // ── Auto-save dashboard state ────────────────────────────────

  app.get("/api/dashboard-state", async (req) => {
    const id = dashboardIdFor(req)
    const state = db.getLayout(id)
    return state ? JSON.parse(state.config) : null
  })

  app.put<{ Body: { views: unknown; activeViewId: string } }>(
    "/api/dashboard-state",
    async (req) => {
      db.saveLayout({
        id: dashboardIdFor(req),
        name: `Dashboard for ${req.session.displayName}`,
        config: JSON.stringify({
          views: req.body.views,
          activeViewId: req.body.activeViewId,
        }),
        updated_at: new Date().toISOString(),
      })
      return { ok: true }
    },
  )

  // ── Named layout snapshots ───────────────────────────────────

  // List all saved layouts
  app.get("/api/layouts", async () => {
    const layouts = db.getLayouts()
    return layouts.map((l) => ({
      id: l.id,
      name: l.name,
      config: JSON.parse(l.config),
      updatedAt: l.updated_at,
    }))
  })

  // Save a layout
  app.post<{ Body: { name: string, config: unknown } }>("/api/layouts", async (req, reply) => {
    const { name, config } = req.body
    if (!name || !config) {
      reply.code(400)
      return { error: "name and config are required" }
    }

    const id = randomUUID()
    db.saveLayout({
      id,
      name: String(name),
      config: JSON.stringify(config),
      updated_at: new Date().toISOString(),
    })

    reply.code(201)
    return { id }
  })

  // Update a layout
  app.put<{ Params: { id: string }, Body: { name?: string, config?: unknown } }>(
    "/api/layouts/:id",
    async (req, reply) => {
      const existing = db.getLayout(req.params.id)
      if (!existing) {
        reply.code(404)
        return { error: "Layout not found" }
      }

      db.saveLayout({
        id: req.params.id,
        name: req.body.name ? String(req.body.name) : existing.name,
        config: req.body.config ? JSON.stringify(req.body.config) : existing.config,
        updated_at: new Date().toISOString(),
      })

      return { ok: true }
    },
  )

  // Delete a layout
  app.delete<{ Params: { id: string } }>("/api/layouts/:id", async (req) => {
    db.deleteLayout(req.params.id)
    return { ok: true }
  })
}
