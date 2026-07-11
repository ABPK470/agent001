/**
 * Migration 0003 — one-time scrub of legacy kebab-case catalog ids in SQLite.
 */

import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { parsePresetSteps } from "../src/platform/persistence/db/sync-run-catalog.js"
import { runBaselineMigration } from "../src/platform/persistence/migrations/0001_baseline.js"
import { runSyncCatalogVersionsMigration } from "../src/platform/persistence/migrations/0002_sync_catalog_versions.js"
import { runCatalogCamelcaseIdsMigration } from "../src/platform/persistence/migrations/0003_catalog_camelcase_ids.js"

let testDb: Database.Database

beforeEach(() => {
  testDb = new Database(":memory:")
  testDb.pragma("foreign_keys = ON")
  runBaselineMigration(testDb)
  runSyncCatalogVersionsMigration(testDb)
})

afterEach(() => {
  testDb.close()
})

describe("catalog_camelcase_ids migration", () => {
  it("rewrites kebab-case flow step kinds in sync_run_presets", () => {
    testDb
      .prepare(
        `INSERT INTO sync_run_presets
         (tenant_id, id, label, description, steps_json, built_in, updated_at, updated_by)
         VALUES ('_default', 'content', 'Content', '', ?, 1, datetime('now'), 'test')`,
      )
      .run(
        JSON.stringify([
          {
            id: "metadata-sync",
            phase: "metadata",
            kind: "metadata-sync",
            title: "Metadata sync",
            description: "Apply metadata",
          },
        ]),
      )

    runCatalogCamelcaseIdsMigration(testDb)

    const row = testDb
      .prepare(`SELECT steps_json FROM sync_run_presets WHERE tenant_id = '_default' AND id = 'content'`)
      .get() as { steps_json: string }
    const steps = parsePresetSteps(row.steps_json)
    expect(steps[0]?.id).toBe("metadataSync")
    expect(steps[0]?.kind).toBe("metadataSync")
  })
})
