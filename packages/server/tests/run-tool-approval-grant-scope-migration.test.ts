/**
 * grant_scope lives in baseline. Pre-squash installs may still have ghost
 * schema_migrations rows (2..N). Boot must: (1) add the column idempotently,
 * (2) prune orphan ledger rows so the next follow-up can be 0002 everywhere.
 */

import Database from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"
import { MIGRATIONS, runMigrations } from "../src/infra/persistence/adapters/sqlite/migrations/index.js"

function seedPreSquashLedger(db: Database.Database): void {
  db.exec(`
    CREATE TABLE schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TEXT NOT NULL
    );
    INSERT INTO schema_migrations (version, name, applied_at) VALUES
      (1, 'baseline', '2026-07-19'),
      (2, 'sync_tool_approvals', '2026-07-22'),
      (3, 'drop_agent_configs', '2026-07-23'),
      (4, 'event_log_columns', '2026-07-28'),
      (5, 'eval_dataset', '2026-08-02'),
      (6, 'drop_browser_tables', '2026-08-03'),
      (7, 'run_tool_approval_grant_scope', '2026-08-05');

    CREATE TABLE run_tool_approvals (
      id            TEXT PRIMARY KEY,
      run_id        TEXT NOT NULL,
      step_id       TEXT NOT NULL,
      tool_name     TEXT NOT NULL,
      args_json     TEXT NOT NULL,
      reason        TEXT NOT NULL,
      policy_name   TEXT NOT NULL,
      status        TEXT NOT NULL,
      requested_at  TEXT NOT NULL,
      resolved_at   TEXT,
      resolved_by   TEXT,
      UNIQUE(run_id, step_id)
    );
  `)
}

describe("run_tool_approvals grant_scope in baseline", () => {
  let db: Database.Database

  afterEach(() => {
    db?.close()
  })

  it("keeps only baseline in MIGRATIONS so the next follow-up is version 2", () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual([1])
    expect(MIGRATIONS[0]?.name).toBe("baseline")
  })

  it("adds grant_scope and prunes ghost ledger rows on a pre-squash DB", () => {
    db = new Database(":memory:")
    seedPreSquashLedger(db)

    runMigrations(db)

    const cols = db.prepare("PRAGMA table_info(run_tool_approvals)").all() as Array<{ name: string }>
    expect(cols.some((c) => c.name === "grant_scope")).toBe(true)

    const versions = (
      db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all() as Array<{
        version: number
        name: string
      }>
    )
    expect(versions).toEqual([{ version: 1, name: "baseline" }])
  })

  it("is idempotent when grant_scope already exists", () => {
    db = new Database(":memory:")
    seedPreSquashLedger(db)
    db.exec(`ALTER TABLE run_tool_approvals ADD COLUMN grant_scope TEXT NOT NULL DEFAULT 'instance'`)

    runMigrations(db)
    runMigrations(db)

    const cols = db.prepare("PRAGMA table_info(run_tool_approvals)").all() as Array<{ name: string }>
    expect(cols.filter((c) => c.name === "grant_scope")).toHaveLength(1)
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n,
    ).toBe(1)
  })
})
