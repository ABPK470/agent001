/**
 * Test helpers that seed parent rows required by the FK constraints
 * introduced in the schema redesign:
 *   - runs.session_id    → sessions(sid)  NOT NULL  CASCADE
 *   - attachments.run_id → runs(id)       NULLABLE  SET NULL
 *   - attachments.session_id → sessions(sid) NULLABLE CASCADE
 *
 * Tests that pre-date the redesign created attachments referencing
 * synthetic runIds (e.g. "run-1") that never had a runs row. With FK
 * enforcement on these inserts now fail. Use the helpers below to
 * pre-seed the parents in beforeEach (or before each upload).
 */
import type Database from "better-sqlite3"

export function seedSession(db: Database.Database, sid: string, upn: string | null = null): void {
  db.prepare(
    `INSERT OR IGNORE INTO sessions (sid, upn, display_name, created_at, last_seen_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
  ).run(sid, upn, upn)
}

export function seedRun(
  db: Database.Database,
  runId: string,
  opts: { sessionSid?: string; goal?: string; status?: string } = {},
): void {
  const sid = opts.sessionSid ?? "sid-test"
  seedSession(db, sid)
  db.prepare(
    `INSERT OR IGNORE INTO runs (id, goal, status, session_id, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  ).run(runId, opts.goal ?? "test", opts.status ?? "completed", sid)
}

export function seedRuns(
  db: Database.Database,
  runIds: readonly string[],
  opts: { sessionSid?: string } = {},
): void {
  for (const id of runIds) seedRun(db, id, opts)
}
