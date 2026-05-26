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

import { newSid } from "../auth/session.js"
import { getDb } from "./db-connection.js"

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
  is_admin: number   // 0 | 1
}

export function createSession(args: {
  upn: string
  ip: string
  userAgent: string
}): string {
  const sid = newSid()
  getDb().prepare(`
    INSERT INTO sessions (sid, upn, ip, user_agent, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(sid, args.upn.toLowerCase(), args.ip, args.userAgent)
  return sid
}

export function touchSession(sid: string): void {
  getDb()
    .prepare("UPDATE sessions SET last_seen_at = datetime('now') WHERE sid = ?")
    .run(sid)
}

export function deleteSession(sid: string): void {
  getDb().prepare("DELETE FROM sessions WHERE sid = ?").run(sid)
}

export function deleteSessionsForUser(upn: string): void {
  getDb()
    .prepare("DELETE FROM sessions WHERE upn = ?")
    .run(upn.toLowerCase())
}

/**
 * Look up a session and JOIN with users. Returns null if the sid does
 * not match any row (e.g. logged out / revoked). Used by the identity
 * hook on every request.
 */
export function getSessionWithUser(sid: string): SessionWithUser | null {
  const row = getDb().prepare(`
    SELECT s.sid, s.upn, s.ip, s.user_agent, s.created_at, s.last_seen_at,
           u.display_name, u.is_admin
    FROM sessions s
    JOIN users u ON u.upn = s.upn
    WHERE s.sid = ?
  `).get(sid) as SessionWithUser | undefined
  return row ?? null
}

export function getSession(sid: string): DbSession | undefined {
  return getDb()
    .prepare("SELECT * FROM sessions WHERE sid = ?")
    .get(sid) as DbSession | undefined
}

export function listSessions(opts?: { sinceSeconds?: number }): SessionWithUser[] {
  const since = opts?.sinceSeconds
  const sql = `
    SELECT s.sid, s.upn, s.ip, s.user_agent, s.created_at, s.last_seen_at,
           u.display_name, u.is_admin
    FROM sessions s
    JOIN users u ON u.upn = s.upn
    ${since !== undefined ? "WHERE s.last_seen_at >= datetime('now', ?)" : ""}
    ORDER BY s.last_seen_at DESC
  `
  return since !== undefined
    ? getDb().prepare(sql).all(`-${since} seconds`) as SessionWithUser[]
    : getDb().prepare(sql).all() as SessionWithUser[]
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
 */
export function listUsersWithStats(opts?: {
  sinceSeconds?: number
  activityWindowSeconds?: number
}): UserStatsRow[] {
  const sinceSeconds = opts?.sinceSeconds ?? 604_800
  const activityWindow = opts?.activityWindowSeconds ?? 86_400
  const rows = getDb().prepare(`
    WITH grouped_sessions AS (
      SELECT
        u.upn                  AS upn,
        u.display_name         AS display_name,
        u.is_admin             AS is_admin,
        COUNT(s.sid)           AS session_count,
        MIN(s.created_at)      AS first_seen_at,
        MAX(s.last_seen_at)    AS last_seen_at,
        (SELECT s2.ip         FROM sessions s2 WHERE s2.upn = u.upn ORDER BY s2.last_seen_at DESC LIMIT 1) AS last_ip,
        (SELECT s2.user_agent FROM sessions s2 WHERE s2.upn = u.upn ORDER BY s2.last_seen_at DESC LIMIT 1) AS last_user_agent
      FROM users u
      LEFT JOIN sessions s ON s.upn = u.upn AND s.last_seen_at >= datetime('now', ?)
      GROUP BY u.upn
    ),
    run_totals AS (
      SELECT
        upn AS upn,
        COUNT(*) AS total_runs,
        SUM(CASE WHEN created_at >= datetime('now', ?) THEN 1 ELSE 0 END) AS runs_24h,
        SUM(CASE WHEN created_at >= datetime('now', ?) AND status IN ('error','failed','timeout') THEN 1 ELSE 0 END) AS runs_failed_24h,
        MAX(created_at) AS last_run_at
      FROM runs
      GROUP BY upn
    ),
    token_totals AS (
      SELECT
        r.upn AS upn,
        SUM(t.total_tokens) AS total_tokens_24h,
        SUM(t.llm_calls)    AS total_llm_calls_24h
      FROM runs r
      JOIN token_usage t ON t.run_id = r.id
      WHERE r.created_at >= datetime('now', ?)
      GROUP BY r.upn
    ),
    last_models AS (
      SELECT upn, model FROM (
        SELECT
          r.upn AS upn,
          t.model,
          ROW_NUMBER() OVER (PARTITION BY r.upn ORDER BY t.created_at DESC) AS rn
        FROM runs r
        JOIN token_usage t ON t.run_id = r.id
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
    LEFT JOIN run_totals   rt ON rt.upn = g.upn
    LEFT JOIN token_totals tt ON tt.upn = g.upn
    LEFT JOIN last_models  lm ON lm.upn = g.upn
    ORDER BY g.last_seen_at DESC
  `).all(
    `-${sinceSeconds} seconds`,
    `-${activityWindow} seconds`,
    `-${activityWindow} seconds`,
    `-${activityWindow} seconds`,
  ) as Array<{
    upn: string; display_name: string; is_admin: number
    session_count: number; first_seen_at: string | null; last_seen_at: string | null
    last_ip: string | null; last_user_agent: string | null
    total_runs: number; runs_24h: number; runs_failed_24h: number
    total_tokens_24h: number; total_llm_calls_24h: number
    last_run_at: string | null; last_model: string | null
  }>

  const onlineCutoff = Date.now() - 60_000
  return rows.map((r) => ({
    identifier:       r.upn,
    upn:              r.upn,
    displayName:      r.display_name,
    isAdmin:          r.is_admin === 1,
    sessionCount:     r.session_count,
    firstSeenAt:      r.first_seen_at ?? "",
    lastSeenAt:       r.last_seen_at ?? "",
    online:           r.last_seen_at ? Date.parse(r.last_seen_at + "Z") >= onlineCutoff : false,
    lastIp:           r.last_ip,
    lastUserAgent:    r.last_user_agent,
    totalRuns:        r.total_runs,
    runs24h:          r.runs_24h,
    runsFailed24h:    r.runs_failed_24h,
    totalTokens24h:   r.total_tokens_24h,
    totalLlmCalls24h: r.total_llm_calls_24h,
    lastRunAt:        r.last_run_at,
    lastModel:        r.last_model,
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
export function listUserHistory(identifier: string, limit = 25, offset = 0): { runs: UserHistoryRunRow[]; total: number } {
  // v19: identifier is always a UPN (anonymous "sid:..." identifiers are gone).
  // We strip the legacy "sid:" prefix defensively so older client links keep working.
  const upn = identifier.startsWith("sid:") ? identifier.slice(4) : identifier
  const total = (getDb()
    .prepare("SELECT COUNT(*) AS cnt FROM runs WHERE upn = ?")
    .get(upn) as { cnt: number }).cnt
  const rows = getDb().prepare(`
    SELECT
      r.id, r.goal, r.status, r.step_count, r.created_at, r.completed_at, r.error,
      t.total_tokens, t.llm_calls, t.model
    FROM runs r
    LEFT JOIN token_usage t ON t.run_id = r.id
    WHERE r.upn = ?
    ORDER BY r.created_at DESC
    LIMIT ? OFFSET ?
  `).all(upn, limit, offset) as Array<{
    id: string; goal: string; status: string; step_count: number
    created_at: string; completed_at: string | null; error: string | null
    total_tokens: number | null; llm_calls: number | null; model: string | null
  }>
  return {
    total,
    runs: rows.map((r) => {
      const parseTs = (s: string) =>
        /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? Date.parse(s) : Date.parse(s.replace(" ", "T") + "Z")
      const startedMs   = parseTs(r.created_at)
      const completedMs = r.completed_at ? parseTs(r.completed_at) : null
      return {
        runId:       r.id,
        goal:        r.goal,
        status:      r.status,
        stepCount:   r.step_count,
        createdAt:   r.created_at,
        completedAt: r.completed_at,
        durationMs:  completedMs ? completedMs - startedMs : null,
        totalTokens: r.total_tokens,
        llmCalls:    r.llm_calls,
        model:       r.model,
        error:       r.error,
      }
    }),
  }
}
