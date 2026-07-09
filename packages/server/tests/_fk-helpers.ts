/**
 * Test helpers that seed parent rows required by FK constraints.
 *
 *   - users(upn) is the canonical identity row, NOT NULL FK target everywhere
 *   - sessions(sid) → users(upn) for auth cookie tests only
 *   - runs(upn) → users
 */
import type Database from "better-sqlite3"

export function seedUser(
  db: Database.Database,
  upn: string,
  opts: { displayName?: string; isAdmin?: boolean } = {}
): void {
  db.prepare(
    `INSERT OR IGNORE INTO users (upn, username, display_name, is_admin, source, created_at)
     VALUES (?, ?, ?, ?, 'local', datetime('now'))`
  ).run(
    upn,
    upn,
    opts.displayName ?? upn,
    opts.isAdmin ? 1 : 0
  )
}

export function seedSession(db: Database.Database, sid: string, upn: string = "test-user@local"): void {
  seedUser(db, upn)
  db.prepare(
    `INSERT OR IGNORE INTO sessions (sid, upn, created_at, last_seen_at)
     VALUES (?, ?, datetime('now'), datetime('now'))`
  ).run(sid, upn)
}

export function seedRun(
  db: Database.Database,
  runId: string,
  opts: { upn?: string; displayName?: string; goal?: string; status?: string } = {}
): void {
  const upn = opts.upn ?? "test-user@local"
  seedUser(db, upn)
  db.prepare(
    `INSERT OR IGNORE INTO runs (id, goal, status, upn, display_name, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  ).run(runId, opts.goal ?? "test", opts.status ?? "completed", upn, opts.displayName ?? upn)
}

export function seedRuns(
  db: Database.Database,
  runIds: readonly string[],
  opts: { upn?: string } = {}
): void {
  for (const id of runIds) seedRun(db, id, opts)
}

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
  "u@x"
] as const

export function seedTestUsers(db: Database.Database, extra: readonly string[] = []): void {
  for (const upn of TEST_USERS) seedUser(db, upn)
  for (const upn of extra) seedUser(db, upn)
}
