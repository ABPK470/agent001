/**
 * Admin observability + login routes.
 *
 *   POST /api/admin/login   — { password } → sets agent001_admin cookie
 *   POST /api/admin/logout  — clears the cookie
 *   GET  /api/admin/sessions          — list of recent sessions (admin only)
 *   GET  /api/admin/active-runs       — currently executing runs (admin only)
 *
 * Admin gating:
 *   - UPN whitelist (AGENT001_ADMIN_UPNS) is the primary path; req.session.isAdmin
 *     reflects it. Set in identity.ts.
 *   - Password fallback uses AGENT001_ADMIN_PASSWORD; if unset, login is disabled.
 */

import type { FastifyInstance } from "fastify"
import { timingSafeEqual } from "node:crypto"
import { ADMIN_COOKIE, signAdminCookie } from "../auth/session.js"
import { getDb } from "../db/connection.js"
import { listSessions, listUserHistory, listUsersWithStats } from "../db/sessions.js"
import type { AgentOrchestrator } from "../orchestrator.js"

function getAdminPassword(): string | null {
  const pw = process.env["AGENT001_ADMIN_PASSWORD"]
  return pw && pw.length > 0 ? pw : null
}

function constantTimeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export function registerAdminRoutes(app: FastifyInstance, orchestrator: AgentOrchestrator): void {
  app.post<{ Body: { password?: string } }>("/api/admin/login", async (req, reply) => {
    const expected = getAdminPassword()
    if (!expected) {
      reply.code(503)
      return { error: "Admin password login is disabled (AGENT001_ADMIN_PASSWORD not set)" }
    }
    const supplied = (req.body?.password ?? "").trim()
    if (!supplied || !constantTimeEq(supplied, expected)) {
      reply.code(401)
      return { error: "Invalid password" }
    }
    reply.setCookie(ADMIN_COOKIE, signAdminCookie(), {
      httpOnly: true,
      sameSite: "lax",
      secure:   process.env["NODE_ENV"] === "production",
      path:     "/",
      maxAge:   60 * 60 * 24 * 30,
    })
    return { ok: true, isAdmin: true }
  })

  app.post("/api/admin/logout", async (_req, reply) => {
    reply.clearCookie(ADMIN_COOKIE, { path: "/" })
    return { ok: true }
  })

  // ── Observability (admin-only) ──────────────────────────────

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
        session_id: string | null; upn: string | null; display_name: string | null
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

  // ── Per-user aggregates + history ────────────────────────────

  app.get("/api/admin/users", async (req, reply) => {
    if (!req.session.isAdmin) { reply.code(403); return { error: "admin only" } }
    const q = req.query as Record<string, string | undefined>
    const sinceSeconds          = Number(q["sinceSeconds"]          ?? "604800")  // 7d
    const activityWindowSeconds = Number(q["activityWindowSeconds"] ?? "86400")   // 24h
    const users = listUsersWithStats({ sinceSeconds, activityWindowSeconds })

    // Mark users with currently-executing runs.
    const activeIds = orchestrator.getActiveRunIds()
    let activeByIdentifier = new Map<string, number>()
    if (activeIds.length > 0) {
      const placeholders = activeIds.map(() => "?").join(",")
      const rows = getDb().prepare(`
        SELECT COALESCE(upn, 'sid:' || session_id) AS identifier, COUNT(*) AS n
        FROM runs WHERE id IN (${placeholders})
        GROUP BY identifier
      `).all(...activeIds) as Array<{ identifier: string; n: number }>
      activeByIdentifier = new Map(rows.map((r) => [r.identifier, r.n]))
    }

    return {
      users: users.map((u) => ({ ...u, activeRuns: activeByIdentifier.get(u.identifier) ?? 0 })),
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
    // Identifier is URL-encoded UPN or `sid:<sid>`.
    const identifier = decodeURIComponent(req.params.identifier)
    return { runs: listUserHistory(identifier, limit) }
  })
}
