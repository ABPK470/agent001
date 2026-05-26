import { migrateSessionFkSetNull } from "../adapters/persistence/db-connection.js"
import { getDb } from "../adapters/persistence/sqlite.js"
import type { MemoryEntry, MemoryRole, MemorySource, MemoryTier } from "./types.js"

// ── Schema migration ─────────────────────────────────────────────

export function migrateMemory(): void {
  const db = getDb()

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id           TEXT PRIMARY KEY,
      tier         TEXT NOT NULL CHECK (tier IN ('working', 'episodic', 'semantic')),
      role         TEXT NOT NULL DEFAULT 'assistant'
        CHECK (role IN ('user','assistant','tool','system','summary')),
      content      TEXT NOT NULL,
      metadata     TEXT NOT NULL DEFAULT '{}',
      source       TEXT NOT NULL DEFAULT 'agent'
        CHECK (source IN ('system','tool','user','agent','external')),
      confidence   REAL NOT NULL DEFAULT 0.5,
      salience     REAL NOT NULL DEFAULT 0.5,
      access_count INTEGER NOT NULL DEFAULT 0,
      session_id   TEXT REFERENCES sessions(sid)      ON DELETE SET NULL,
      run_id       TEXT REFERENCES runs(id)           ON DELETE SET NULL,
      parent_id    TEXT REFERENCES memory_entries(id) ON DELETE SET NULL,
      upn          TEXT,
      shared       INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_me_tier    ON memory_entries(tier);
    CREATE INDEX IF NOT EXISTS idx_me_session ON memory_entries(session_id);
    CREATE INDEX IF NOT EXISTS idx_me_run     ON memory_entries(run_id);
    CREATE INDEX IF NOT EXISTS idx_me_created ON memory_entries(created_at);
    CREATE INDEX IF NOT EXISTS idx_me_upn     ON memory_entries(upn);
    CREATE INDEX IF NOT EXISTS idx_me_shared  ON memory_entries(shared);

    CREATE TABLE IF NOT EXISTS procedural_memories (
      id            TEXT PRIMARY KEY,
      trigger       TEXT NOT NULL,
      tool_sequence TEXT NOT NULL,
      success_count INTEGER NOT NULL DEFAULT 1,
      failure_count INTEGER NOT NULL DEFAULT 0,
      run_id        TEXT REFERENCES runs(id)      ON DELETE SET NULL,
      session_id    TEXT REFERENCES sessions(sid) ON DELETE SET NULL,
      upn           TEXT,
      shared        INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_proc_upn     ON procedural_memories(upn);
    CREATE INDEX IF NOT EXISTS idx_proc_session ON procedural_memories(session_id);
    CREATE INDEX IF NOT EXISTS idx_proc_shared  ON procedural_memories(shared);

    CREATE TABLE IF NOT EXISTS memory_vectors (
      entry_id  TEXT PRIMARY KEY REFERENCES memory_entries(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL,
      dimension INTEGER NOT NULL,
      -- Tenant columns mirrored from memory_entries so vectorSearch can
      -- push tenant isolation into the SQL JOIN instead of post-filtering
      -- top-K. Without this, a tenant whose rows dominate the cosine
      -- top-K can starve everyone else of vector recall.
      upn       TEXT,
      shared    INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_mv_upn    ON memory_vectors(upn);
    CREATE INDEX IF NOT EXISTS idx_mv_shared ON memory_vectors(shared);
  `)

  // v23: pre-existing DBs may still have `ON DELETE CASCADE` on
  // memory_entries.session_id / procedural_memories.session_id, which
  // would make user logout cascade-wipe their memories. Rewrite to
  // SET NULL before the FTS triggers below get attached so the
  // table-rebuild does not orphan the FTS5 shadow rows. No-op once
  // the tables are already on the new schema.
  migrateSessionFkSetNull(db)

  // FTS5 for memory_entries — create then integrity-check and rebuild if corrupt.
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

  // Detect and auto-repair a corrupted FTS index (SQLITE_CORRUPT_VTAB).
  // `integrity-check` returns one row per error; an empty result means healthy.
  try {
    const ftsErrors = db
      .prepare("INSERT INTO memory_entries_fts(memory_entries_fts) VALUES ('integrity-check')")
      .run()
    void ftsErrors
  } catch {
    // FTS is corrupt — drop and rebuild from the base table.
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
      // Repopulate from the main table.
      db.exec(`
        INSERT INTO memory_entries_fts(rowid, content, metadata)
        SELECT rowid, content, metadata FROM memory_entries;
      `)
      console.warn("[memory] FTS index rebuilt successfully.")
    } catch (rebuildErr) {
      console.error("[memory] FTS rebuild failed:", rebuildErr)
    }
  }

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

  // ── tool_knowledge: org-wide cache of heavy MSSQL-tool outputs ──
  // Separate from memory_entries because these are objective ground-truth
  // facts about DB objects (not user-scoped notes): cross-UPN by default,
  // keyed by exact (tool, qname, mode, connection), invalidated by catalog
  // fingerprint + TTL. See /memories/repo/tool-knowledge-cache.md.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_knowledge (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      tool            TEXT NOT NULL,
      qname           TEXT NOT NULL,
      mode            TEXT NOT NULL DEFAULT '',
      connection      TEXT NOT NULL DEFAULT 'default',
      payload_text    TEXT NOT NULL,
      fingerprint     TEXT NOT NULL,
      bytes           INTEGER NOT NULL,
      created_by_upn  TEXT,
      created_at      INTEGER NOT NULL,
      last_hit_at     INTEGER,
      hit_count       INTEGER NOT NULL DEFAULT 0,
      UNIQUE(tool, qname, mode, connection)
    );

    CREATE INDEX IF NOT EXISTS idx_tk_lookup  ON tool_knowledge(tool, qname);
    CREATE INDEX IF NOT EXISTS idx_tk_created ON tool_knowledge(created_at);
  `)
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
    upn: (row.upn as string) ?? null,
    shared: (row.shared as number) === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}
