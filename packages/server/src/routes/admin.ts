/**
 * Admin observability routes (v19, accounts-based).
 *
 *   GET  /api/admin/sessions       — list of recent sessions (admin only)
 *   GET  /api/admin/active-runs    — currently executing runs (admin only)
 *   GET  /api/admin/users          — per-user activity aggregates (admin only)
 *   GET  /api/admin/users/:id/runs — a user's recent runs (admin only)
 *
 * Admin gating: req.session.isAdmin (sourced from users.is_admin column).
 * The legacy admin password login + ADMIN_COOKIE machinery were removed
 * in v19 — admin status is a property of the account.
 */

import type { FastifyInstance } from "fastify"
import { getDb } from "../db/connection.js"
import { listSessions, listUserHistory, listUsersWithStats } from "../db/sessions.js"
import type { AgentOrchestrator } from "../orchestrator/index.js"

export function registerAdminRoutes(app: FastifyInstance, orchestrator: AgentOrchestrator): void {
  app.get("/api/admin/sessions", async (req, reply) => {
    if (!req.session.isAdmin) { reply.code(403); return { error: "admin only" } }
    const since = Number(((req.query as Record<string, string>)?.["sinceSeconds"]) ?? "604800") // default 7 days
    const sessions = listSessions({ sinceSeconds: since })
    const onlineCutoff = Date.now() - 60_000
    return {
      sessions: sessions.map((s) => ({
        sid:         s.sid,
        upn:         s.upn,
        displayName: s.display_name,
        isAdmin:     s.is_admin === 1,
        ip:          s.ip,
        userAgent:   s.user_agent,
        createdAt:   s.created_at,
        lastSeenAt:  s.last_seen_at,
        online:      Date.parse(s.last_seen_at + "Z") >= onlineCutoff,
      })),
    }
  })

  app.get("/api/admin/active-runs", async (req, reply) => {
    if (!req.session.isAdmin) { reply.code(403); return { error: "admin only" } }
    const activeIds = orchestrator.getActiveRunIds()
    if (activeIds.length === 0) return { runs: [] }
    const placeholders = activeIds.map(() => "?").join(",")
    const rows = getDb()
      .prepare(`
        SELECT id, goal, status, step_count, created_at, session_id, upn, display_name
        FROM runs
        WHERE id IN (${placeholders})
        ORDER BY created_at DESC
      `)
      .all(...activeIds) as Array<{
        id: string; goal: string; status: string; step_count: number; created_at: string
        session_id: string; upn: string; display_name: string
      }>
    return {
      runs: rows.map((r) => ({
        runId:       r.id,
        goal:        r.goal,
        status:      r.status,
        stepCount:   r.step_count,
        createdAt:   r.created_at,
        sessionId:   r.session_id,
        upn:         r.upn,
        displayName: r.display_name,
      })),
    }
  })

  app.get("/api/admin/users", async (req, reply) => {
    if (!req.session.isAdmin) { reply.code(403); return { error: "admin only" } }
    const q = req.query as Record<string, string | undefined>
    const sinceSeconds          = Number(q["sinceSeconds"]          ?? "604800")  // 7d
    const activityWindowSeconds = Number(q["activityWindowSeconds"] ?? "86400")   // 24h
    const users = listUsersWithStats({ sinceSeconds, activityWindowSeconds })

    // Mark users with currently-executing runs.
    const activeIds = orchestrator.getActiveRunIds()
    let activeByUpn = new Map<string, number>()
    if (activeIds.length > 0) {
      const placeholders = activeIds.map(() => "?").join(",")
      const rows = getDb().prepare(`
        SELECT upn, COUNT(*) AS n
        FROM runs WHERE id IN (${placeholders})
        GROUP BY upn
      `).all(...activeIds) as Array<{ upn: string; n: number }>
      activeByUpn = new Map(rows.map((r) => [r.upn, r.n]))
    }

    return {
      users: users.map((u) => ({ ...u, activeRuns: activeByUpn.get(u.upn) ?? 0 })),
      summary: {
        users:        users.length,
        online:       users.filter((u) => u.online).length,
        runsInFlight: activeIds.length,
        runs24h:      users.reduce((a, u) => a + u.runs24h, 0),
        tokens24h:    users.reduce((a, u) => a + u.totalTokens24h, 0),
      },
    }
  })

  app.get<{ Params: { identifier: string } }>("/api/admin/users/:identifier/runs", async (req, reply) => {
    if (!req.session.isAdmin) { reply.code(403); return { error: "admin only" } }
    const limit = Math.min(200, Math.max(1, Number((req.query as Record<string, string>)?.["limit"] ?? "25")))
    const offset = Math.max(0, Number((req.query as Record<string, string>)?.["offset"] ?? "0"))
    // Identifier is URL-encoded UPN (legacy "sid:" prefix tolerated by listUserHistory).
    const identifier = decodeURIComponent(req.params.identifier)
    const { runs, total } = listUserHistory(identifier, limit, offset)
    return { runs, total, limit, offset }
  })
}
