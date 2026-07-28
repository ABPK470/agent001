/**
 * Migration 4 — denormalize event_log ownership / correlation columns.
 *
 * Hot list/filter paths use actor_upn, run_id, plan_id instead of json_extract.
 * Backfill from existing JSON payloads; indexes for Personal scoping.
 */

import type Database from "better-sqlite3"

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return cols.some((c) => c.name === column)
}

export function runEventLogColumnsMigration(db: Database.Database): void {
  if (!hasColumn(db, "event_log", "actor_upn")) {
    db.exec("ALTER TABLE event_log ADD COLUMN actor_upn TEXT")
  }
  if (!hasColumn(db, "event_log", "run_id")) {
    db.exec("ALTER TABLE event_log ADD COLUMN run_id TEXT")
  }
  if (!hasColumn(db, "event_log", "plan_id")) {
    db.exec("ALTER TABLE event_log ADD COLUMN plan_id TEXT")
  }

  db.exec(`
    UPDATE event_log SET
      actor_upn = lower(coalesce(
        json_extract(data, '$.actorUpn'),
        json_extract(data, '$.upn'),
        json_extract(data, '$.userUpn')
      )),
      run_id = json_extract(data, '$.runId'),
      plan_id = coalesce(
        json_extract(data, '$.planId'),
        CASE
          WHEN typeof(json_extract(data, '$.opId')) = 'text'
            AND json_extract(data, '$.opId') LIKE 'plan%'
          THEN json_extract(data, '$.opId')
          ELSE NULL
        END
      )
    WHERE actor_upn IS NULL AND run_id IS NULL AND plan_id IS NULL
  `)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_event_log_actor_upn ON event_log(actor_upn);
    CREATE INDEX IF NOT EXISTS idx_event_log_run_id ON event_log(run_id);
    CREATE INDEX IF NOT EXISTS idx_event_log_plan_id ON event_log(plan_id);
  `)
}
