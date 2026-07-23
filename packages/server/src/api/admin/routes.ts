import { parseBoundaryJson } from "../../internal/parse-json.js"

/**
 * Admin observability transport routes.
 */

import type { FastifyInstance } from "fastify"
import { listSessions, listUserHistory, listUsersWithStats } from "../../infra/persistence/sessions.js"
import { setUserAdmin } from "../../infra/persistence/db/users.js"
import * as db from "../../infra/persistence/sqlite.js"
import { getDb } from "../../infra/persistence/sqlite.js"
import type { AgentOrchestrator } from "../../runtime/orchestrator.js"

function parseAuditScopeType(raw: string | undefined): db.AuditScopeType | undefined {
  if (raw === "run" || raw === "admin") return raw
  return undefined
}

function parseAuditSort(raw: string | undefined): db.AuditLogSort {
  return raw === "timestamp_asc" ? "timestamp_asc" : "timestamp_desc"
}

function parseAuditQuery(query: Record<string, string | undefined>): db.ListAuditLogPaginatedInput {
  const page = Math.max(1, Number(query.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 50))
  return {
    page,
    pageSize,
    scopeType: parseAuditScopeType(query.scopeType),
    scopeId: query.scopeId?.trim() || undefined,
    runId: query.runId?.trim() || undefined,
    threadId: query.threadId?.trim() || undefined,
    user: query.user?.trim() || query.runUpn?.trim() || undefined,
    action: query.action?.trim() || undefined,
    search: query.q?.trim() || undefined,
    from: query.from?.trim() || undefined,
    to: query.to?.trim() || undefined,
    sort: parseAuditSort(query.sort),
  }
}

function parseAuditDetail(raw: string): Record<string, unknown> {
  try {
    const parsed = parseBoundaryJson(raw) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed }
  } catch {
    return { raw }
  }
}

/** Resolve the human user UPN for an audit row (run owner or admin actor). */
function auditUserUpn(row: db.DbAuditWithRun): string | null {
  if (row.run_upn?.trim()) return row.run_upn.trim()
  const actor = row.actor?.trim() ?? ""
  if (actor && actor !== "user" && actor !== "agent") return actor
  return null
}

function mapAuditRow(row: db.DbAuditWithRun) {
  return {
    id: row.id ?? 0,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    runId: row.run_id,
    threadId: row.thread_id,
    threadTitle: row.thread_title,
    user: auditUserUpn(row),
    action: row.action,
    detail: parseAuditDetail(row.detail),
    timestamp: row.timestamp,
    run: row.run_id
      ? {
          goal: row.run_goal,
          status: row.run_status,
          upn: row.run_upn,
          displayName: row.run_display_name,
        }
      : null,
  }
}

function csvEscape(value: unknown): string {
  const text = value == null ? "" : String(value)
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

function auditRowsToCsv(rows: ReturnType<typeof mapAuditRow>[]): string {
  const header = [
    "id",
    "timestamp",
    "scopeType",
    "scopeId",
    "user",
    "action",
    "runId",
    "threadId",
    "threadTitle",
    "runStatus",
    "runGoal",
    "detail",
  ]
  const lines = [header.join(",")]
  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.timestamp,
        row.scopeType,
        row.scopeId ?? "",
        row.user ?? "",
        row.action,
        row.runId ?? "",
        row.threadId ?? "",
        row.threadTitle ?? "",
        row.run?.status ?? "",
        row.run?.goal ?? "",
        JSON.stringify(row.detail),
      ]
        .map(csvEscape)
        .join(","),
    )
  }
  return lines.join("\n") + "\n"
}

export function registerAdminRoutes(app: FastifyInstance, orchestrator: AgentOrchestrator): void {
  app.get("/api/admin/sessions", async (req, reply) => {
    if (!req.session.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    const since = Number((req.query as Record<string, string>)?.["sinceSeconds"] ?? "604800")
    const sessions = listSessions({ sinceSeconds: since })
    const onlineCutoff = Date.now() - 60_000
    return {
      sessions: sessions.map((session) => ({
        sid: session.sid,
        upn: session.upn,
        displayName: session.display_name,
        isAdmin: session.is_admin === 1,
        ip: session.ip,
        userAgent: session.user_agent,
        createdAt: session.created_at,
        lastSeenAt: session.last_seen_at,
        online: Date.parse(session.last_seen_at + "Z") >= onlineCutoff
      }))
    }
  })

  app.get("/api/admin/active-runs", async (req, reply) => {
    if (!req.session.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    const activeIds = orchestrator.getActiveRunIds()
    if (activeIds.length === 0) return { runs: [] }
    const placeholders = activeIds.map(() => "?").join(",")
    const rows = getDb()
      .prepare(
        `
				SELECT id, goal, status, step_count, created_at, upn, display_name
				FROM runs
				WHERE id IN (${placeholders})
				ORDER BY created_at DESC
			`
      )
      .all(...activeIds) as Array<{
      id: string
      goal: string
      status: string
      step_count: number
      created_at: string
      upn: string
      display_name: string
    }>
    return {
      runs: rows.map((row) => ({
        runId: row.id,
        goal: row.goal,
        status: row.status,
        stepCount: row.step_count,
        createdAt: row.created_at,
        upn: row.upn,
        displayName: row.display_name
      }))
    }
  })

  app.get("/api/admin/users", async (req, reply) => {
    if (!req.session.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    const q = req.query as Record<string, string | undefined>
    const sinceSeconds = Number(q["sinceSeconds"] ?? "604800")
    const activityWindowSeconds = Number(q["activityWindowSeconds"] ?? "86400")
    const users = listUsersWithStats({ sinceSeconds, activityWindowSeconds })

    const activeIds = orchestrator.getActiveRunIds()
    let activeByUpn = new Map<string, number>()
    if (activeIds.length > 0) {
      const placeholders = activeIds.map(() => "?").join(",")
      const rows = getDb()
        .prepare(
          `
				SELECT upn, COUNT(*) AS n
				FROM runs WHERE id IN (${placeholders})
				GROUP BY upn
			`
        )
        .all(...activeIds) as Array<{ upn: string; n: number }>
      activeByUpn = new Map(rows.map((row) => [row.upn, row.n]))
    }

    return {
      users: users.map((user) => ({ ...user, activeRuns: activeByUpn.get(user.upn) ?? 0 })),
      summary: {
        users: users.length,
        online: users.filter((user) => user.online).length,
        runsInFlight: activeIds.length,
        runs24h: users.reduce((acc, user) => acc + user.runs24h, 0),
        tokens24h: users.reduce((acc, user) => acc + user.totalTokens24h, 0)
      }
    }
  })

  app.get<{ Params: { identifier: string } }>("/api/admin/users/:identifier/runs", async (req, reply) => {
    if (!req.session.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    const limit = Math.min(200, Math.max(1, Number((req.query as Record<string, string>)?.["limit"] ?? "25")))
    const offset = Math.max(0, Number((req.query as Record<string, string>)?.["offset"] ?? "0"))
    const identifier = decodeURIComponent(req.params.identifier)
    const { runs, total } = listUserHistory(identifier, limit, offset)
    return { runs, total, limit, offset }
  })

  app.patch<{ Params: { identifier: string }; Body: { isAdmin?: boolean } }>(
    "/api/admin/users/:identifier/admin",
    async (req, reply) => {
      if (!req.session.isAdmin) {
        reply.code(403)
        return { error: "admin only" }
      }
      if (typeof req.body?.isAdmin !== "boolean") {
        reply.code(400)
        return { error: "'isAdmin' boolean required" }
      }
      const identifier = decodeURIComponent(req.params.identifier)
      try {
        const updated = setUserAdmin(identifier, req.body.isAdmin)
        return {
          upn: updated.upn,
          displayName: updated.display_name,
          isAdmin: updated.is_admin === 1,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "update failed"
        if (message.includes("not found")) {
          reply.code(404)
        } else {
          reply.code(400)
        }
        return { error: message }
      }
    },
  )

  // ── Platform-wide audit browser (admin only) ─────────────────────

  app.get("/api/admin/audit/options", async (req, reply) => {
    if (!req.session.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    return db.listAuditFilterOptions()
  })

  app.get("/api/admin/audit", async (req, reply) => {
    if (!req.session.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    const filters = parseAuditQuery(req.query as Record<string, string | undefined>)
    const total = db.countAuditLog(filters)
    const rows = db.listAuditLogPaginated(filters)
    const totalPages = Math.max(1, Math.ceil(total / filters.pageSize))
    return {
      items: rows.map(mapAuditRow),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
      totalPages,
    }
  })

  app.get("/api/admin/audit/export", async (req, reply) => {
    if (!req.session.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    const q = req.query as Record<string, string | undefined>
    const format = q.format === "json" ? "json" : "csv"
    const filters = parseAuditQuery({ ...q, page: "1", pageSize: "10000" })
    const total = db.countAuditLog(filters)
    if (total > 10_000) {
      reply.code(400)
      return {
        error: `Export limited to 10,000 rows (matched ${total}). Narrow the time window or filters.`,
      }
    }
    const rows = db.listAuditLogPaginated({ ...filters, page: 1, pageSize: Math.max(total, 1) }).map(mapAuditRow)
    const stamp = new Date().toISOString().slice(0, 10)
    if (format === "json") {
      reply.header("content-type", "application/json; charset=utf-8")
      reply.header("content-disposition", `attachment; filename="mia-audit-${stamp}.json"`)
      return rows
    }
    reply.header("content-type", "text/csv; charset=utf-8")
    reply.header("content-disposition", `attachment; filename="mia-audit-${stamp}.csv"`)
    return auditRowsToCsv(rows)
  })
}
