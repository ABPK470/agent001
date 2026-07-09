import type Database from "better-sqlite3"
import { getDb } from "../sqlite.js"
import type { MemoryEntry, MemoryRole, MemorySource, MemoryTier } from "./types.js"

/**
 * FTS5 virtual tables and integrity repair — runs after schema migrations on boot.
 * Base tables are created by migration `0001_baseline`.
 */
export function initMemoryFts(db: Database.Database = getDb()): void {

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_entries_fts USING fts5(
        content,
        metadata,
        content='memory_entries',
        content_rowid='rowid'
      );
    `)
  } catch {
    /* already exists */
  }

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

// ── Row mappers ──────────────────────────────────────────────────

export function rowToEntry(row: Record<string, unknown>): MemoryEntry {
  return {
    id: row.id as string,
    tier: row.tier as MemoryTier,
    role: (row.role as MemoryRole) ?? "assistant",
    content: row.content as string,
    metadata:
      typeof row.metadata === "string"
        ? JSON.parse(row.metadata)
        : ((row.metadata as Record<string, unknown>) ?? {}),
    source: (row.source as MemorySource) ?? "agent",
    confidence: (row.confidence as number) ?? 0.5,
    salience: (row.salience as number) ?? 0.5,
    accessCount: (row.access_count as number) ?? 0,
    runId: (row.run_id as string) ?? null,
    parentId: (row.parent_id as string) ?? null,
    upn: (row.upn as string) ?? null,
    shared: (row.shared as number) === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}
