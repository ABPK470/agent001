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
  // Persist every session including anonymous ('anon:<hex>') and
  // header-derived ('header:<upn>') sids. The cookie keeps the anon sid
  // stable across requests, so this row also stays stable. Required for
  // the runs.session_id foreign key to resolve.
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

/**
 * Reuse an existing anonymous session for the same browser fingerprint.
 *
 * Why: when a brand-new tab opens an SSE stream as its first request, our
 * onRequest hook can fail to set the sticky `mia_sid` cookie (best-effort,
 * see auth/identity.ts). The next request from the same tab then arrives
 * with no cookie and `resolveSession` would mint a fresh `anon:<hex>` sid,
 * fragmenting the sessions table into N orphan rows per real browser.
 *
 * Collapsing on (ip, user_agent) within a recency window lets those orphan
 * requests rejoin the existing session row and keeps run / notification /
 * memory FK chains intact.
 *
 * Caveats:
 *  - Two anonymous users on the same machine + browser look identical here.
 *    Acceptable: they're "Anonymous" until one of them submits the welcome
 *    modal, which mints a new sid (see /api/me handler).
 *  - Window is intentionally short to avoid resurrecting stale identities
 *    after a long idle period.
 */
export function findRecentAnonSidByFingerprint(
  ip: string,
  userAgent: string,
  windowSeconds = 86_400,
): string | undefined {
  const row = getDb()
    .prepare(`
      SELECT sid FROM sessions
      WHERE upn IS NULL
        AND sid LIKE 'anon:%'
        AND ip = ?
        AND user_agent = ?
        AND last_seen_at >= datetime('now', ?)
      ORDER BY last_seen_at DESC
      LIMIT 1
    `)
    .get(ip, userAgent, `-${windowSeconds} seconds`) as { sid: string } | undefined
  return row?.sid
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
 * Aggregates sessions + runs + token_usage grouped by UPN, or by sid for
 * every no-UPN session. One row per login/session when no stable identity
 * exists, which keeps two anonymous "John" users separate in the admin UI.
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
        -- For UPN-identified users: group by UPN.
        -- For every no-UPN session: group by sid. Display name is metadata,
        -- not identity; two anonymous users named "John" must remain distinct.
        CASE
          WHEN upn IS NOT NULL THEN upn
          ELSE 'sid:' || sid
        END                          AS identifier,
        MAX(upn)                     AS upn,
        -- Use the most-recently-seen display_name, not MAX() which picks
        -- lexicographically-largest (e.g. 'pk' beats 'admin').
        (SELECT display_name FROM sessions s2
           WHERE CASE
             WHEN s2.upn IS NOT NULL THEN s2.upn
             ELSE 'sid:' || s2.sid
           END = CASE
             WHEN sessions.upn IS NOT NULL THEN sessions.upn
             ELSE 'sid:' || sessions.sid
           END
           ORDER BY s2.last_seen_at DESC LIMIT 1) AS display_name,
        COUNT(*)                     AS session_count,
        MIN(created_at)              AS first_seen_at,
        MAX(last_seen_at)            AS last_seen_at,
        (SELECT ip         FROM sessions s2
           WHERE CASE
             WHEN s2.upn IS NOT NULL THEN s2.upn
             ELSE 'sid:' || s2.sid
           END = CASE
             WHEN sessions.upn IS NOT NULL THEN sessions.upn
             ELSE 'sid:' || sessions.sid
           END
           ORDER BY s2.last_seen_at DESC LIMIT 1) AS last_ip,
        (SELECT user_agent FROM sessions s2
           WHERE CASE
             WHEN s2.upn IS NOT NULL THEN s2.upn
             ELSE 'sid:' || s2.sid
           END = CASE
             WHEN sessions.upn IS NOT NULL THEN sessions.upn
             ELSE 'sid:' || sessions.sid
           END
           ORDER BY s2.last_seen_at DESC LIMIT 1) AS last_user_agent
      FROM sessions
      WHERE last_seen_at >= datetime('now', ?)
      GROUP BY identifier
    ),
    run_totals AS (
      -- Resolve each run to the same identifier space used by grouped_sessions:
      -- UPN → upn, no-UPN → 'sid:'||session_id.
      SELECT
        CASE
          WHEN r.upn IS NOT NULL THEN r.upn
          ELSE 'sid:' || r.session_id
        END AS identifier,
        COUNT(*) AS total_runs,
        SUM(CASE WHEN r.created_at >= datetime('now', ?) THEN 1 ELSE 0 END) AS runs_24h,
        SUM(CASE WHEN r.created_at >= datetime('now', ?) AND r.status IN ('error','failed','timeout') THEN 1 ELSE 0 END) AS runs_failed_24h,
        MAX(r.created_at) AS last_run_at
      FROM runs r
      LEFT JOIN sessions s ON s.sid = r.session_id
      WHERE r.upn IS NOT NULL OR r.session_id IS NOT NULL
      GROUP BY identifier
    ),
    token_totals AS (
      SELECT
        CASE
          WHEN r.upn IS NOT NULL THEN r.upn
          ELSE 'sid:' || r.session_id
        END AS identifier,
        SUM(t.total_tokens) AS total_tokens_24h,
        SUM(t.llm_calls)    AS total_llm_calls_24h
      FROM runs r
      JOIN token_usage t ON t.run_id = r.id
      LEFT JOIN sessions s ON s.sid = r.session_id
      WHERE r.created_at >= datetime('now', ?)
      GROUP BY identifier
    ),
    last_models AS (
      SELECT
        identifier, model
      FROM (
        SELECT
          CASE
            WHEN r.upn IS NOT NULL THEN r.upn
            ELSE 'sid:' || r.session_id
          END AS identifier,
          t.model,
          ROW_NUMBER() OVER (PARTITION BY
            CASE
              WHEN r.upn IS NOT NULL THEN r.upn
              ELSE 'sid:' || r.session_id
            END
          ORDER BY t.created_at DESC) AS rn
        FROM runs r
        JOIN token_usage t ON t.run_id = r.id
        LEFT JOIN sessions s ON s.sid = r.session_id
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
 * no-UPN sessions). Joined with token_usage so the widget can render
 * tokens / model in one round-trip.
 */
export function listUserHistory(identifier: string, limit = 25, offset = 0): { runs: UserHistoryRunRow[]; total: number } {
  const isSid  = identifier.startsWith("sid:")
  const key = isSid ? identifier.slice(4) : identifier

  // Two identifier spaces match listUsersWithStats:
  //   upn       → runs.upn = ?
  //   sid:<sid> → runs.session_id = ? AND runs.upn IS NULL
  const joinClause  = ``
  const whereClause = isSid
    ? `WHERE r.session_id = ? AND r.upn IS NULL`
    : `WHERE r.upn = ?`
  const countSql = `SELECT COUNT(*) AS cnt FROM runs r ${joinClause} ${whereClause}`
  const total = (getDb().prepare(countSql).get(key) as { cnt: number }).cnt
  const rows = getDb().prepare(`
    SELECT
      r.id, r.goal, r.status, r.step_count, r.created_at, r.completed_at, r.error,
      t.total_tokens, t.llm_calls, t.model
    FROM runs r
    LEFT JOIN token_usage t ON t.run_id = r.id
    ${joinClause}
    ${whereClause}
    ORDER BY r.created_at DESC
    LIMIT ? OFFSET ?
  `).all(key, limit, offset) as Array<{
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


