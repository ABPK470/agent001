/**
 * Layouts API routes — save/load dashboard configurations.
 */

import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import * as db from "../db.js";

/**
 * Per-user well-known dashboard ID. Falls back to session_id for cookie-only
 * (no UPN) visitors so each browser session gets its own layout. Anonymous
 * (pre-welcome) requests get a transient sid that won't persist anyway.
 */
function dashboardIdFor(req: { session?: { upn?: string | null; sid?: string; isAdmin?: boolean } }): string {
  const s = req.session
  // Admin users authenticated via access code have upn=null (code is consumed, not stored).
  // Use a stable "admin" key so their layout survives re-logins and server restarts.
  if (s?.isAdmin && !s.upn) return "dashboard:admin"
  const key = (s?.upn ?? s?.sid ?? "anon").toLowerCase()
  return `dashboard:${key}`
}

/** Pre-multi-user dashboard id (single global layout). Used as a one-time
 *  fallback for admins so the layout from before the per-user split isn't lost. */
const LEGACY_DASHBOARD_ID = "__dashboard_state__"

/** True if a saved dashboard config has no actual content (a single empty view).
 *  Used to detect the throw-away default the UI saves on first mount so we
 *  can still hand the admin the legacy layout. */
function isEmptyDashboard(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return true
  const views = (parsed as { views?: Array<{ widgets?: unknown[] }> }).views
  if (!Array.isArray(views) || views.length === 0) return true
  return views.every((v) => !Array.isArray(v.widgets) || v.widgets.length === 0)
}

export function registerLayoutRoutes(app: FastifyInstance): void {

  // ── Auto-save dashboard state ────────────────────────────────

  app.get("/api/dashboard-state", async (req) => {
    const id = dashboardIdFor(req)
    const state = db.getLayout(id)
    const parsed = state ? JSON.parse(state.config) : null

    // Admin-only legacy fallback: if there's no saved state OR the saved state
    // is an empty default (the UI auto-saves a blank "Main" on first mount),
    // hand back the pre-split global dashboard and copy it under the admin's
    // key so it persists across reloads.
    if (req.session?.isAdmin && (!parsed || isEmptyDashboard(parsed))) {
      const legacy = db.getLayout(LEGACY_DASHBOARD_ID)
      if (legacy) {
        const legacyParsed = JSON.parse(legacy.config)
        db.saveLayout({
          id,
          name: `Dashboard for ${req.session.displayName ?? "admin"}`,
          config: legacy.config,
          updated_at: new Date().toISOString(),
        })
        return legacyParsed
      }
    }
    return parsed
  })

  app.put<{ Body: { views: unknown; activeViewId: string } }>(
    "/api/dashboard-state",
    async (req) => {
      db.saveLayout({
        id: dashboardIdFor(req),
        name: `Dashboard for ${req.session?.displayName ?? "anon"}`,
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
