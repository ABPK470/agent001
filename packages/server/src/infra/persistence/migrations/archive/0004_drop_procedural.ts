/**
 * Drop procedural_memories — choreography folded into episodic summaries.
 */

import type Database from "better-sqlite3"

export function runDropProceduralMigration(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS procedural_ai;
    DROP TRIGGER IF EXISTS procedural_ad;
    DROP TRIGGER IF EXISTS procedural_au;
    DROP TABLE IF EXISTS procedural_fts;
    DROP TABLE IF EXISTS procedural_memories;
  `)
}
