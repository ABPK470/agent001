import type Database from "better-sqlite3"

/**
 * Durable store for clarification resolutions — the agent's learned
 * business-term → warehouse-object mappings.
 *
 * Why: `ClarificationsRegistry` is per-run and in-memory, so a user answer
 * to "what do you mean by clients?" was discarded on run completion and the
 * question re-asked every run. This table persists those answers (org-wide,
 * like `tool_knowledge`) so the clarify detectors can suppress re-asking a
 * subject the org has already resolved. See `memory/resolved-terms.ts` for
 * the read/write helpers and `clarify-cluster` for the suppression path.
 */
export function runResolvedTermsMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resolved_terms (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      term            TEXT NOT NULL,
      qname           TEXT NOT NULL,
      connection      TEXT NOT NULL DEFAULT 'default',
      created_by_upn  TEXT,
      created_at      INTEGER NOT NULL,
      last_hit_at     INTEGER,
      hit_count       INTEGER NOT NULL DEFAULT 0,
      UNIQUE(term, qname, connection)
    );
    CREATE INDEX IF NOT EXISTS idx_rt_term       ON resolved_terms(term);
    CREATE INDEX IF NOT EXISTS idx_rt_conn       ON resolved_terms(connection);
    CREATE INDEX IF NOT EXISTS idx_rt_created    ON resolved_terms(created_at DESC);
  `)
}
