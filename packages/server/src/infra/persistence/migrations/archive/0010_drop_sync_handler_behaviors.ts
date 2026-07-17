import type Database from "better-sqlite3"

/** Handler types are code-owned; step types embed handler config — no separate catalog table. */
export function runDropSyncHandlerBehaviorsMigration(db: Database.Database): void {
  db.exec(`DROP TABLE IF EXISTS sync_handler_behaviors;`)
}
