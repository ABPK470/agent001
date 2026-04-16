import { getDb } from "../db.js"
import type { MemoryEntry, MemoryRole, MemorySource, MemoryTier } from "./types.js"

// ── Schema migration ─────────────────────────────────────────────

export function migrateMemory(): void {
  const db = getDb()

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      tier TEXT NOT NULL CHECK (tier IN ('working', 'episodic', 'semantic')),
      role TEXT NOT NULL DEFAULT 'assistant',
      content TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL DEFAULT 'agent',
      confidence REAL NOT NULL DEFAULT 0.5,
      salience REAL NOT NULL DEFAULT 0.5,
      access_count INTEGER NOT NULL DEFAULT 0,
      session_id TEXT,
      run_id TEXT,
      parent_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_me_tier ON memory_entries(tier);
    CREATE INDEX IF NOT EXISTS idx_me_session ON memory_entries(session_id);
    CREATE INDEX IF NOT EXISTS idx_me_run ON memory_entries(run_id);
    CREATE INDEX IF NOT EXISTS idx_me_created ON memory_entries(created_at);

    CREATE TABLE IF NOT EXISTS procedural_memories (
      id TEXT PRIMARY KEY,
      trigger TEXT NOT NULL,
      tool_sequence TEXT NOT NULL,
      success_count INTEGER NOT NULL DEFAULT 1,
      failure_count INTEGER NOT NULL DEFAULT 0,
      run_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_vectors (
      entry_id TEXT PRIMARY KEY REFERENCES memory_entries(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL,
      dimension INTEGER NOT NULL
    );
  `)

  // FTS5 for memory_entries
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_entries_fts USING fts5(
        content,
        metadata,
        content='memory_entries',
        content_rowid='rowid'
      );
    `)
  } catch { /* already exists */ }

  // FTS5 for procedural
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS procedural_fts USING fts5(
        trigger,
        content='procedural_memories',
        content_rowid='rowid'
      );
    `)
  } catch { /* already exists */ }

  // Sync triggers
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

    CREATE TRIGGER IF NOT EXISTS procedural_ai AFTER INSERT ON procedural_memories BEGIN
      INSERT INTO procedural_fts(rowid, trigger)
      VALUES (new.rowid, new.trigger);
    END;

    CREATE TRIGGER IF NOT EXISTS procedural_ad AFTER DELETE ON procedural_memories BEGIN
      INSERT INTO procedural_fts(procedural_fts, rowid, trigger)
      VALUES ('delete', old.rowid, old.trigger);
    END;

    CREATE TRIGGER IF NOT EXISTS procedural_au AFTER UPDATE ON procedural_memories BEGIN
      INSERT INTO procedural_fts(procedural_fts, rowid, trigger)
      VALUES ('delete', old.rowid, old.trigger);
      INSERT INTO procedural_fts(rowid, trigger)
      VALUES (new.rowid, new.trigger);
    END;
  `)

  // Migrate data from old 'memories' table if it exists
  try {
    const oldExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='memories'"
    ).get()
    if (oldExists) {
      db.exec(`
        INSERT OR IGNORE INTO memory_entries (id, tier, role, content, metadata, source, confidence, salience, access_count, session_id, run_id, parent_id, created_at, updated_at)
        SELECT id,
               CASE WHEN tier = 'procedural' THEN 'episodic' ELSE tier END,
               'assistant',
               content,
               metadata,
               source,
               confidence,
               0.5,
               access_count,
               NULL,
               run_id,
               NULL,
               created_at,
               updated_at
        FROM memories;

        DROP TABLE IF EXISTS memories_fts;
        DROP TABLE IF EXISTS memories;
      `)
    }
  } catch { /* migration already done or table doesn't exist */ }
}

// ── Row mappers ──────────────────────────────────────────────────

export function rowToEntry(row: Record<string, unknown>): MemoryEntry {
  return {
    id: row.id as string,
    tier: row.tier as MemoryTier,
    role: (row.role as MemoryRole) ?? "assistant",
    content: row.content as string,
    metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : (row.metadata as Record<string, unknown>) ?? {},
    source: (row.source as MemorySource) ?? "agent",
    confidence: (row.confidence as number) ?? 0.5,
    salience: (row.salience as number) ?? 0.5,
    accessCount: (row.access_count as number) ?? 0,
    sessionId: (row.session_id as string) ?? null,
    runId: (row.run_id as string) ?? null,
    parentId: (row.parent_id as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}
