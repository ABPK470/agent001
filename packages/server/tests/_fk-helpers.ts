/**
 * Test helpers that seed parent rows required by FK constraints (v19).
 *
 * v19 schema:
 *   - users(upn) is the canonical identity row, NOT NULL FK target everywhere
 *   - sessions(sid) → users(upn) NOT NULL CASCADE; no display_name on sessions
 *   - runs(upn, session_id) → users + sessions, both NOT NULL
 *   - attachments(owner_upn, session_id) → users + sessions
 *
 * Tests that pre-date v19 inserted runs/sessions without seeding the user
 * row first; with FK enforcement those inserts now fail. Use the helpers
 * below from `beforeEach` to seed the parent chain.
 */
import type Database from "better-sqlite3"

export function seedUser(
  db: Database.Database,
  upn: string,
  opts: { displayName?: string; isAdmin?: boolean } = {},
): void {
  db.prepare(
    `INSERT OR IGNORE INTO users (upn, username, display_name, is_admin, source, created_at)
     VALUES (?, ?, ?, ?, 'local', datetime('now'))`,
  ).run(
    upn,
    upn,                                       // username = upn for tests
    opts.displayName ?? upn,
    opts.isAdmin ? 1 : 0,
  )
}

export function seedSession(
  db: Database.Database,
  sid: string,
  upn: string = "test-user@local",
): void {
  seedUser(db, upn)
  db.prepare(
    `INSERT OR IGNORE INTO sessions (sid, upn, created_at, last_seen_at)
     VALUES (?, ?, datetime('now'), datetime('now'))`,
  ).run(sid, upn)
}

export function seedRun(
  db: Database.Database,
  runId: string,
  opts: { sessionSid?: string; upn?: string; displayName?: string; goal?: string; status?: string } = {},
): void {
  const upn = opts.upn ?? "test-user@local"
  const sid = opts.sessionSid ?? "sid-test"
  seedSession(db, sid, upn)
  db.prepare(
    `INSERT OR IGNORE INTO runs (id, goal, status, session_id, upn, display_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    runId,
    opts.goal ?? "test",
    opts.status ?? "completed",
    sid,
    upn,
    opts.displayName ?? upn,
  )
}

export function seedRuns(
  db: Database.Database,
  runIds: readonly string[],
  opts: { sessionSid?: string; upn?: string } = {},
): void {
  for (const id of runIds) seedRun(db, id, opts)
}

/**
 * Seed the standard test-fixture user pool so tests using arbitrary
 * `*@example.com` upns can exercise FK-bound services (attachments,
 * browser credentials/proxy/policy/context, notifications, runs).
 *
 * Add new upns here when a test needs one — the helper is idempotent.
 */
export const TEST_USERS = [
  "alice@example.com",
  "bob@example.com",
  "eve@example.com",
  "owner@example.com",
  "other@example.com",
  "admin@example.com",
  "test.user@example.com",
  "test-user@local",
  "alice@x",
  "bob@x",
  "u@x",
] as const

export function seedTestUsers(db: Database.Database, extra: readonly string[] = []): void {
  for (const upn of TEST_USERS) seedUser(db, upn)
  for (const upn of extra) seedUser(db, upn)
}
