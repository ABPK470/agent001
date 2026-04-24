/**
 * Session persistence — upsert the current session into the `sessions`
 * table and bump last_seen_at. Powers the admin "Active Users" widget.
 *
 * Called from the identity middleware for every request (cheap upsert).
 */

import { getDb } from "./connection.js"

export interface DbSession {
  sid: string
  upn: string | null
  display_name: string | null
  ip: string | null
  user_agent: string | null
  created_at: string
  last_seen_at: string
}

export function touchSession(s: {
  sid: string
  upn: string | null
  displayName: string
  ip: string
  userAgent: string
}): void {
  // Skip transient anonymous sessions — they spawn a new sid each request and
  // would flood the table. Welcome-modal sessions get persisted on POST /api/me
  // (their sid is stable across requests via the cookie).
  if (s.sid.startsWith("anon:")) return
  getDb().prepare(`
    INSERT INTO sessions (sid, upn, display_name, ip, user_agent, created_at, last_seen_at)
    VALUES (@sid, @upn, @display_name, @ip, @user_agent, datetime('now'), datetime('now'))
    ON CONFLICT(sid) DO UPDATE SET
      upn          = excluded.upn,
      display_name = excluded.display_name,
      ip           = excluded.ip,
      user_agent   = excluded.user_agent,
      last_seen_at = datetime('now')
  `).run({
    sid:          s.sid,
    upn:          s.upn,
    display_name: s.displayName,
    ip:           s.ip,
    user_agent:   s.userAgent,
  })
}

export function listSessions(opts?: { sinceSeconds?: number }): DbSession[] {
  const since = opts?.sinceSeconds
  if (since !== undefined) {
    return getDb()
      .prepare(`
        SELECT * FROM sessions
        WHERE last_seen_at >= datetime('now', ?)
        ORDER BY last_seen_at DESC
      `)
      .all(`-${since} seconds`) as DbSession[]
  }
  return getDb()
    .prepare("SELECT * FROM sessions ORDER BY last_seen_at DESC")
    .all() as DbSession[]
}

export function getSession(sid: string): DbSession | undefined {
  return getDb()
    .prepare("SELECT * FROM sessions WHERE sid = ?")
    .get(sid) as DbSession | undefined
}

// ── Per-user aggregations (admin observability) ──────────────────

export interface UserStatsRow {
  /** Stable identity key — the UPN if present, otherwise `sid:<sid>`. */
  identifier: string
  upn: string | null
  displayName: string | null
  sessionCount: number
  firstSeenAt: string  // earliest created_at across that user's sessions
  lastSeenAt: string   // latest last_seen_at
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
 * Aggregates sessions + runs + token_usage grouped by UPN (or by sid for
 * anonymous visitors who never set a UPN). One row per real-world user.
 *
 * @param sinceSeconds — window for "session counted as recent" (default 7d)
 * @param activityWindowSeconds — window for "runs24h / tokens24h" (default 24h)
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
        COALESCE(upn, 'sid:' || sid) AS identifier,
        MAX(upn)                     AS upn,
        MAX(display_name)            AS display_name,
        COUNT(*)                     AS session_count,
        MIN(created_at)              AS first_seen_at,
        MAX(last_seen_at)            AS last_seen_at,
        (SELECT ip         FROM sessions s2
           WHERE COALESCE(s2.upn, 'sid:' || s2.sid) = COALESCE(sessions.upn, 'sid:' || sessions.sid)
           ORDER BY s2.last_seen_at DESC LIMIT 1) AS last_ip,
        (SELECT user_agent FROM sessions s2
           WHERE COALESCE(s2.upn, 'sid:' || s2.sid) = COALESCE(sessions.upn, 'sid:' || sessions.sid)
           ORDER BY s2.last_seen_at DESC LIMIT 1) AS last_user_agent
      FROM sessions
      WHERE last_seen_at >= datetime('now', ?)
      GROUP BY identifier
    ),
    run_totals AS (
      SELECT
        COALESCE(upn, 'sid:' || session_id) AS identifier,
        COUNT(*) AS total_runs,
        SUM(CASE WHEN created_at >= datetime('now', ?) THEN 1 ELSE 0 END) AS runs_24h,
        SUM(CASE WHEN created_at >= datetime('now', ?) AND status IN ('error','failed','timeout') THEN 1 ELSE 0 END) AS runs_failed_24h,
        MAX(created_at) AS last_run_at
      FROM runs
      WHERE upn IS NOT NULL OR session_id IS NOT NULL
      GROUP BY identifier
    ),
    token_totals AS (
      SELECT
        COALESCE(r.upn, 'sid:' || r.session_id) AS identifier,
        SUM(t.total_tokens) AS total_tokens_24h,
        SUM(t.llm_calls)    AS total_llm_calls_24h
      FROM runs r
      JOIN token_usage t ON t.run_id = r.id
      WHERE r.created_at >= datetime('now', ?)
      GROUP BY identifier
    ),
    last_models AS (
      SELECT
        identifier, model
      FROM (
        SELECT
          COALESCE(r.upn, 'sid:' || r.session_id) AS identifier,
          t.model,
          ROW_NUMBER() OVER (PARTITION BY COALESCE(r.upn, 'sid:' || r.session_id) ORDER BY t.created_at DESC) AS rn
        FROM runs r
        JOIN token_usage t ON t.run_id = r.id
      )
      WHERE rn = 1
    )
    SELECT
      g.identifier,
      g.upn,
      g.display_name,
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
    LEFT JOIN run_totals   rt ON rt.identifier = g.identifier
    LEFT JOIN token_totals tt ON tt.identifier = g.identifier
    LEFT JOIN last_models  lm ON lm.identifier = g.identifier
    ORDER BY g.last_seen_at DESC
  `).all(
    `-${sinceSeconds} seconds`,
    `-${activityWindow} seconds`,
    `-${activityWindow} seconds`,
    `-${activityWindow} seconds`,
  ) as Array<{
    identifier: string; upn: string | null; display_name: string | null
    session_count: number; first_seen_at: string; last_seen_at: string
    last_ip: string | null; last_user_agent: string | null
    total_runs: number; runs_24h: number; runs_failed_24h: number
    total_tokens_24h: number; total_llm_calls_24h: number
    last_run_at: string | null; last_model: string | null
  }>

  const onlineCutoff = Date.now() - 60_000
  return rows.map((r) => ({
    identifier:       r.identifier,
    upn:              r.upn,
    displayName:      r.display_name,
    sessionCount:     r.session_count,
    firstSeenAt:      r.first_seen_at,
    lastSeenAt:       r.last_seen_at,
    online:           Date.parse(r.last_seen_at + "Z") >= onlineCutoff,
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
 * Recent runs for a single user (looked up by UPN, or by `sid:<sid>` for
 * anonymous visitors). Joined with token_usage so the widget can render
 * tokens / model in one round-trip.
 */
export function listUserHistory(identifier: string, limit = 25): UserHistoryRunRow[] {
  const isSid = identifier.startsWith("sid:")
  const key = isSid ? identifier.slice(4) : identifier
  const sql = isSid
    ? `WHERE r.session_id = ? AND r.upn IS NULL`
    : `WHERE r.upn = ?`
  const rows = getDb().prepare(`
    SELECT
      r.id, r.goal, r.status, r.step_count, r.created_at, r.completed_at, r.error,
      t.total_tokens, t.llm_calls, t.model
    FROM runs r
    LEFT JOIN token_usage t ON t.run_id = r.id
    ${sql}
    ORDER BY r.created_at DESC
    LIMIT ?
  `).all(key, limit) as Array<{
    id: string; goal: string; status: string; step_count: number
    created_at: string; completed_at: string | null; error: string | null
    total_tokens: number | null; llm_calls: number | null; model: string | null
  }>
  return rows.map((r) => {
    const startedMs   = Date.parse(r.created_at + "Z")
    const completedMs = r.completed_at ? Date.parse(r.completed_at + "Z") : null
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
  })
}


