import type Database from "better-sqlite3"

/** Channel conversations own their continuity thread — not looked up via runs. */
export function runConversationThreadIdMigration(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === "thread_id")) {
    db.exec(`ALTER TABLE conversations ADD COLUMN thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL`)
  }
}
