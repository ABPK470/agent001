import type Database from "better-sqlite3"
export { rowToEntry } from "../../../memory/row.js"

/**
 * FTS5 virtual tables and integrity repair — runs after schema migrations on boot.
 * Base tables are created by migration `0001_baseline`.
 */
export function initMemoryFts(db: Database.Database): void {

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_entries_fts USING fts5(
        content,
        metadata,
        content='memory_entries',
        content_rowid='rowid'
      );
    `)
  } catch (err: unknown) { console.error("[mia]", err) }

  try {
    const ftsErrors = db
      .prepare("INSERT INTO memory_entries_fts(memory_entries_fts) VALUES ('integrity-check')")
      .run()
    void ftsErrors
  } catch {
    console.warn("[memory] memory_entries_fts corrupt — rebuilding FTS index...")
    try {
      db.exec("DROP TABLE IF EXISTS memory_entries_fts")
      db.exec(`
        CREATE VIRTUAL TABLE memory_entries_fts USING fts5(
          content,
          metadata,
          content='memory_entries',
          content_rowid='rowid'
        );
      `)
      db.exec(`
        INSERT INTO memory_entries_fts(rowid, content, metadata)
        SELECT rowid, content, metadata FROM memory_entries;
      `)
      console.warn("[memory] FTS index rebuilt successfully.")
    } catch (rebuildErr) {
      console.error("[memory] FTS rebuild failed:", rebuildErr)
    }
  }

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS me_fts_ai AFTER INSERT ON memory_entries BEGIN
      INSERT INTO memory_entries_fts(rowid, content, metadata)
      VALUES (new.rowid, new.content, new.metadata);
    END;

    CREATE TRIGGER IF NOT EXISTS me_fts_ad AFTER DELETE ON memory_entries BEGIN
      INSERT INTO memory_entries_fts(memory_entries_fts, rowid, content, metadata)
      VALUES ('delete', old.rowid, old.content, old.metadata);
    END;

    CREATE TRIGGER IF NOT EXISTS me_fts_au AFTER UPDATE ON memory_entries BEGIN
      INSERT INTO memory_entries_fts(memory_entries_fts, rowid, content, metadata)
      VALUES ('delete', old.rowid, old.content, old.metadata);
      INSERT INTO memory_entries_fts(rowid, content, metadata)
      VALUES (new.rowid, new.content, new.metadata);
    END;
  `)
}

