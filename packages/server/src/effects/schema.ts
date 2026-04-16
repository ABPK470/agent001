import { getDb } from "../db.js"

// ── Schema migration ─────────────────────────────────────────────

export function migrateEffects(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS effects (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL,
      tool TEXT NOT NULL,
      target TEXT NOT NULL,
      pre_hash TEXT,
      post_hash TEXT,
      status TEXT NOT NULL DEFAULT 'applied',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_effects_run ON effects(run_id, seq);
    CREATE INDEX IF NOT EXISTS idx_effects_target ON effects(target);

    CREATE TABLE IF NOT EXISTS file_snapshots (
      id TEXT PRIMARY KEY,
      effect_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      content TEXT,
      hash TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (effect_id) REFERENCES effects(id)
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_run ON file_snapshots(run_id);
    CREATE INDEX IF NOT EXISTS idx_snapshots_effect ON file_snapshots(effect_id);
    CREATE INDEX IF NOT EXISTS idx_snapshots_path ON file_snapshots(file_path);
  `)

  try {
    getDb().exec(`ALTER TABLE file_snapshots ADD COLUMN file_mode INTEGER`)
  } catch {
    // Column already exists
  }
}
