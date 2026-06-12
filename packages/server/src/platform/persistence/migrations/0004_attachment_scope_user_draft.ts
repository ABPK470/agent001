import type Database from "better-sqlite3"

/**
 * Rename attachment scope value `session` → `user_draft` (pre-run user uploads).
 * Not related to auth cookie sessions.
 */
export function runAttachmentScopeUserDraftMigration(db: Database.Database): void {
  const hasSessionScope = db
    .prepare(`SELECT 1 FROM attachments WHERE scope = 'session' LIMIT 1`)
    .get()
  const checkRow = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='attachments'`).get() as
    | { sql: string }
    | undefined
  const checkNeedsUpdate = checkRow?.sql?.includes("'session'") ?? false

  if (!hasSessionScope && !checkNeedsUpdate) return

  db.exec(`PRAGMA foreign_keys = OFF`)
  db.exec(`
    CREATE TABLE attachments_new (
      id              TEXT PRIMARY KEY,
      scope           TEXT NOT NULL
        CHECK (scope IN ('run','user_draft','workspace_asset')),
      run_id          TEXT REFERENCES runs(id) ON DELETE SET NULL,
      owner_upn       TEXT NOT NULL REFERENCES users(upn) ON DELETE CASCADE,
      original_name   TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      media_type      TEXT NOT NULL,
      size_bytes      INTEGER NOT NULL,
      content_hash    TEXT NOT NULL,
      storage_uri     TEXT NOT NULL,
      text_extract_uri TEXT,
      ingestion_mode  TEXT NOT NULL
        CHECK (ingestion_mode IN ('text_inline','text_retrieval','binary_reference','provider_file_api')),
      status          TEXT NOT NULL DEFAULT 'uploaded'
        CHECK (status IN ('uploaded','processed','rejected','deleted')),
      source          TEXT NOT NULL DEFAULT 'user_upload'
        CHECK (source IN ('user_upload','generated','promoted')),
      purpose_tag     TEXT,
      goal_snapshot   TEXT,
      uploaded_at     TEXT NOT NULL,
      processed_at    TEXT,
      retention_until TEXT
    );

    INSERT INTO attachments_new (
      id, scope, run_id, owner_upn, original_name, normalized_name, media_type,
      size_bytes, content_hash, storage_uri, text_extract_uri, ingestion_mode,
      status, source, purpose_tag, goal_snapshot, uploaded_at, processed_at, retention_until
    )
    SELECT
      id,
      CASE scope WHEN 'session' THEN 'user_draft' ELSE scope END,
      run_id, owner_upn, original_name, normalized_name, media_type,
      size_bytes, content_hash, storage_uri, text_extract_uri, ingestion_mode,
      status, source, purpose_tag, goal_snapshot, uploaded_at, processed_at, retention_until
    FROM attachments;

    DROP TABLE attachments;
    ALTER TABLE attachments_new RENAME TO attachments;

    CREATE INDEX IF NOT EXISTS idx_attachments_run   ON attachments(run_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_owner ON attachments(owner_upn);
    CREATE INDEX IF NOT EXISTS idx_attachments_hash  ON attachments(content_hash);
  `)
  db.exec(`PRAGMA foreign_keys = ON`)
}
