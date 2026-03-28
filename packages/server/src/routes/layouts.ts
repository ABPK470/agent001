/**
 * Layouts API routes — save/load dashboard configurations.
 */

import type { FastifyInstance } from "fastify"
import { randomUUID } from "node:crypto"
import * as db from "../db.js"

// Well-known ID for auto-saved dashboard state
const DASHBOARD_STATE_ID = "__dashboard_state__"

export function registerLayoutRoutes(app: FastifyInstance): void {

  // ── Auto-save dashboard state ────────────────────────────────

  app.get("/api/dashboard-state", async () => {
    const layouts = db.getLayouts()
    const state = layouts.find((l) => l.id === DASHBOARD_STATE_ID)
    if (!state) return null
    return JSON.parse(state.config)
  })

  app.put<{ Body: { views: unknown; activeViewId: string } }>(
    "/api/dashboard-state",
    async (req) => {
      db.saveLayout({
        id: DASHBOARD_STATE_ID,
        name: "Dashboard Auto-Save",
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
      const existing = db.getLayouts().find((l) => l.id === req.params.id)
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
