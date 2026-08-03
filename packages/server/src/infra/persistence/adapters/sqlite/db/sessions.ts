/**
 * Sessions persistence — opaque transport tokens FK'd to users.
 *
 * In v19 (the real-accounts redesign), sessions hold no identity claims:
 * sid, FK to users(upn), ip, user_agent, timestamps. All identity
 * (display_name, is_admin, …) is JOIN'd from `users` at read time.
 *
 * Lifecycle:
 *   - createSession(upn, ip, ua) — called on POST /api/auth/login and on
 *     SSO header detection.
 *   - touchSession(sid) — bumps last_seen_at on every request.
 *   - deleteSession(sid) — POST /api/auth/logout.
 *
 * The old anonymous-fingerprint reuse logic is gone — there are no anon
 * sessions any more.
 */

import { randomBytes } from "node:crypto"
import { sql } from "kysely"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runAll, runExec, runGet } from "../../../schema/execute.js"
import { platformNow, platformNowMinusSeconds } from "../../../schema/sql-time.js"

function newSid(): string {
  return randomBytes(16).toString("hex")
}

export interface DbSession {
  sid: string
  upn: string
  ip: string | null
  user_agent: string | null
  created_at: string
  last_seen_at: string
}

export interface SessionWithUser extends DbSession {
  display_name: string
  is_admin: number // 0 | 1
}

export function createSession(args: { upn: string; ip: string; userAgent: string }): string {
  const sid = newSid()
  const compiled = getPlatformDb()
    .insertInto("sessions")
    .values({
      sid,
      upn: args.upn.toLowerCase(),
      ip: args.ip,
      user_agent: args.userAgent,
      created_at: platformNow(),
      last_seen_at: platformNow(),
    })
    .compile()
  runExec(compiled)
  return sid
}

export function touchSession(sid: string): void {
  const compiled = getPlatformDb()
    .updateTable("sessions")
    .set({ last_seen_at: platformNow() })
    .where("sid", "=", sid)
    .compile()
  runExec(compiled)
}

export function deleteSession(sid: string): void {
  const compiled = getPlatformDb()
    .deleteFrom("sessions")
    .where("sid", "=", sid)
    .compile()
  runExec(compiled)
}

export function deleteSessionsForUser(upn: string): void {
  const compiled = getPlatformDb()
    .deleteFrom("sessions")
    .where("upn", "=", upn.toLowerCase())
    .compile()
  runExec(compiled)
}

/**
 * Look up a session and JOIN with users. Returns null if the sid does
 * not match any row (e.g. logged out / revoked). Used by the identity
 * hook on every request.
 */
export function getSessionWithUser(sid: string): SessionWithUser | null {
  const compiled = getPlatformDb()
    .selectFrom("sessions")
    .innerJoin("users", "users.upn", "sessions.upn")
    .select([
      "sessions.sid",
      "sessions.upn",
      "sessions.ip",
      "sessions.user_agent",
      "sessions.created_at",
      "sessions.last_seen_at",
      "users.display_name",
      "users.is_admin",
    ])
    .where("sessions.sid", "=", sid)
    .compile()
  return runGet<SessionWithUser>(compiled) ?? null
}

export function getSession(sid: string): DbSession | undefined {
  const compiled = getPlatformDb()
    .selectFrom("sessions")
    .selectAll()
    .where("sid", "=", sid)
    .compile()
  return runGet<DbSession>(compiled)
}

export function listSessions(opts?: { sinceSeconds?: number }): SessionWithUser[] {
  let query = getPlatformDb()
    .selectFrom("sessions")
    .innerJoin("users", "users.upn", "sessions.upn")
    .select([
      "sessions.sid",
      "sessions.upn",
      "sessions.ip",
      "sessions.user_agent",
      "sessions.created_at",
      "sessions.last_seen_at",
      "users.display_name",
      "users.is_admin",
    ])
  if (opts?.sinceSeconds !== undefined) {
    query = query.where(
      sql<boolean>`sessions.last_seen_at >= ${platformNowMinusSeconds(opts.sinceSeconds)}`,
    )
  }
  const compiled = query.orderBy("sessions.last_seen_at", "desc").compile()
  return runAll<SessionWithUser>(compiled)
}

// ── Per-user aggregations (admin observability) ──────────────────

export interface UserStatsRow {
  /** Stable identity key — always the UPN now (anon is gone). */
  identifier: string
  upn: string
  displayName: string
  isAdmin: boolean
  sessionCount: number
  firstSeenAt: string
  lastSeenAt: string
  online: boolean
  lastIp: string | null
  lastUserAgent: string | null
  totalRuns: number
  runs24h: number
  runsFailed24h: number
  totalTokens24h: number
  totalLlmCalls24h: number
  lastRunAt: string | null
  lastModel: string | null
}

/**
 * Per-user activity aggregates. With anonymous sessions removed, every
 * row in `sessions` has a real `upn` and JOINs into `users` — the heavy
 * "group by sid for no-UPN sessions" CTE the v18 query needed is gone.
 *
 * Joins use lower(upn): users/sessions are canonical-lowercased, but older
 * runs may still carry mixed-case UPNs — exact `=` dropped tokens/LLM calls
 * for those users while run counts looked fine when both sides matched.
 */
export function listUsersWithStats(opts?: {
  sinceSeconds?: number
  activityWindowSeconds?: number
}): UserStatsRow[] {
  const sinceSeconds = opts?.sinceSeconds ?? 604_800
  const activityWindow = opts?.activityWindowSeconds ?? 86_400
  const sinceCutoff = platformNowMinusSeconds(sinceSeconds)
  const activityCutoff = platformNowMinusSeconds(activityWindow)
  // Admin CTE — time windows via dialect-aware helpers (milestone 4c).
  const compiled = sql`
    WITH grouped_sessions AS (
      SELECT
        u.upn                  AS upn,
        u.display_name         AS display_name,
        u.is_admin             AS is_admin,
        COUNT(s.sid)           AS session_count,
        MIN(s.created_at)      AS first_seen_at,
        MAX(s.last_seen_at)    AS last_seen_at,
        (SELECT s2.ip         FROM sessions s2 WHERE lower(s2.upn) = lower(u.upn) ORDER BY s2.last_seen_at DESC LIMIT 1) AS last_ip,
        (SELECT s2.user_agent FROM sessions s2 WHERE lower(s2.upn) = lower(u.upn) ORDER BY s2.last_seen_at DESC LIMIT 1) AS last_user_agent
      FROM users u
      LEFT JOIN sessions s ON lower(s.upn) = lower(u.upn) AND s.last_seen_at >= ${sinceCutoff}
      GROUP BY u.upn
    ),
    run_totals AS (
      SELECT
        lower(upn) AS upn,
        COUNT(*) AS total_runs,
        SUM(CASE WHEN created_at >= ${activityCutoff} THEN 1 ELSE 0 END) AS runs_24h,
        SUM(CASE WHEN created_at >= ${activityCutoff} AND status IN ('failed','crashed','timeout','error') THEN 1 ELSE 0 END) AS runs_failed_24h,
        MAX(created_at) AS last_run_at
      FROM runs
      WHERE upn IS NOT NULL AND trim(upn) != ''
      GROUP BY lower(upn)
    ),
    token_totals AS (
      SELECT
        lower(r.upn) AS upn,
        SUM(t.total_tokens) AS total_tokens_24h,
        SUM(t.llm_calls)    AS total_llm_calls_24h
      FROM runs r
      JOIN token_usage t ON t.run_id = r.id
      WHERE r.upn IS NOT NULL AND trim(r.upn) != ''
        AND r.created_at >= ${activityCutoff}
      GROUP BY lower(r.upn)
    ),
    last_models AS (
      SELECT upn, model FROM (
        SELECT
          lower(r.upn) AS upn,
          t.model,
          ROW_NUMBER() OVER (PARTITION BY lower(r.upn) ORDER BY t.created_at DESC) AS rn
        FROM runs r
        JOIN token_usage t ON t.run_id = r.id
        WHERE r.upn IS NOT NULL AND trim(r.upn) != ''
      ) WHERE rn = 1
    )
    SELECT
      g.upn,
      g.display_name,
      g.is_admin,
      g.session_count,
      g.first_seen_at,
      g.last_seen_at,
      g.last_ip,
      g.last_user_agent,
      COALESCE(rt.total_runs, 0)         AS total_runs,
      COALESCE(rt.runs_24h, 0)           AS runs_24h,
      COALESCE(rt.runs_failed_24h, 0)    AS runs_failed_24h,
      COALESCE(tt.total_tokens_24h, 0)   AS total_tokens_24h,
      COALESCE(tt.total_llm_calls_24h, 0) AS total_llm_calls_24h,
      rt.last_run_at,
      lm.model AS last_model
    FROM grouped_sessions g
    LEFT JOIN run_totals   rt ON rt.upn = lower(g.upn)
    LEFT JOIN token_totals tt ON tt.upn = lower(g.upn)
    LEFT JOIN last_models  lm ON lm.upn = lower(g.upn)
    ORDER BY g.last_seen_at DESC
  `.compile(getPlatformDb())
  const rows = runAll<{
    upn: string
    display_name: string
    is_admin: number
    session_count: number
    first_seen_at: string | null
    last_seen_at: string | null
    last_ip: string | null
    last_user_agent: string | null
    total_runs: number
    runs_24h: number
    runs_failed_24h: number
    total_tokens_24h: number
    total_llm_calls_24h: number
    last_run_at: string | null
    last_model: string | null
  }>(compiled)

  const onlineCutoff = Date.now() - 60_000
  return rows.map((r) => ({
    identifier: r.upn,
    upn: r.upn,
    displayName: r.display_name,
    isAdmin: r.is_admin === 1,
    sessionCount: r.session_count,
    firstSeenAt: r.first_seen_at ?? "",
    lastSeenAt: r.last_seen_at ?? "",
    online: r.last_seen_at ? Date.parse(r.last_seen_at + "Z") >= onlineCutoff : false,
    lastIp: r.last_ip,
    lastUserAgent: r.last_user_agent,
    totalRuns: r.total_runs,
    runs24h: r.runs_24h,
    runsFailed24h: r.runs_failed_24h,
    totalTokens24h: r.total_tokens_24h,
    totalLlmCalls24h: r.total_llm_calls_24h,
    lastRunAt: r.last_run_at,
    lastModel: r.last_model
  }))
}

export interface UserHistoryRunRow {
  runId: string
  goal: string
  status: string
  stepCount: number
  createdAt: string
  completedAt: string | null
  durationMs: number | null
  totalTokens: number | null
  llmCalls: number | null
  model: string | null
  error: string | null
}

/**
 * Recent runs for a single user (looked up by UPN). Joined with
 * token_usage so the widget can render tokens / model in one round-trip.
 */
export function listUserHistory(
  identifier: string,
  limit = 25,
  offset = 0
): { runs: UserHistoryRunRow[]; total: number } {
  // v19: identifier is always a UPN (anonymous "sid:..." identifiers are gone).
  // We strip the legacy "sid:" prefix defensively so older client links keep working.
  // Match case-insensitively — users are lowercased; legacy runs may not be.
  const upn = (identifier.startsWith("sid:") ? identifier.slice(4) : identifier).trim().toLowerCase()
  const totalCompiled = getPlatformDb()
    .selectFrom("runs")
    .select(sql<number>`count(*)`.as("cnt"))
    .where(sql<boolean>`lower(upn) = ${upn}`)
    .compile()
  const total = Number(runGet<{ cnt: number | bigint }>(totalCompiled)?.cnt ?? 0)
  const rowsCompiled = getPlatformDb()
    .selectFrom("runs as r")
    .leftJoin("token_usage as t", "t.run_id", "r.id")
    .select([
      "r.id",
      "r.goal",
      "r.status",
      "r.step_count",
      "r.created_at",
      "r.completed_at",
      "r.error",
      "t.total_tokens",
      "t.llm_calls",
      "t.model",
    ])
    .where(sql<boolean>`lower(r.upn) = ${upn}`)
    .orderBy("r.created_at", "desc")
    .limit(limit)
    .offset(offset)
    .compile()
  const rows = runAll<{
    id: string
    goal: string
    status: string
    step_count: number
    created_at: string
    completed_at: string | null
    error: string | null
    total_tokens: number | null
    llm_calls: number | null
    model: string | null
  }>(rowsCompiled)
  return {
    total,
    runs: rows.map((r) => {
      const parseTs = (s: string) =>
        /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? Date.parse(s) : Date.parse(s.replace(" ", "T") + "Z")
      const startedMs = parseTs(r.created_at)
      const completedMs = r.completed_at ? parseTs(r.completed_at) : null
      return {
        runId: r.id,
        goal: r.goal,
        status: r.status,
        stepCount: r.step_count,
        createdAt: r.created_at,
        completedAt: r.completed_at,
        durationMs: completedMs ? completedMs - startedMs : null,
        totalTokens: r.total_tokens,
        llmCalls: r.llm_calls,
        model: r.model,
        error: r.error
      }
    })
  }
}
