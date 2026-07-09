import type Database from "better-sqlite3"

import { BUILTIN_STEP_FIELD_SEEDS } from "@mia/shared-types"

const STEP_FIELD_IDS = ["audit-object-type", "object-name", "pipeline-name"] as const

function migrateHandlerFromRefs(json: string): string {
  let next = json
  for (const fieldId of STEP_FIELD_IDS) {
    next = next.split(`"from":"${fieldId}"`).join(`"from":"flow-step-field:${fieldId}"`)
    next = next.split(`"from": "${fieldId}"`).join(`"from": "flow-step-field:${fieldId}"`)
  }
  return next
}

export function runSyncStepFieldsMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_run_step_fields (
      tenant_id        TEXT NOT NULL,
      id               TEXT NOT NULL,
      label            TEXT NOT NULL,
      built_in         INTEGER NOT NULL DEFAULT 0,
      definition_json  TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (tenant_id, id)
    );
  `)

  for (const seed of BUILTIN_STEP_FIELD_SEEDS) {
    db.prepare(
      `INSERT INTO sync_run_step_fields (tenant_id, id, label, built_in, definition_json)
       VALUES ('_default', ?, ?, 1, ?)
       ON CONFLICT(tenant_id, id) DO UPDATE SET
         label = excluded.label,
         definition_json = CASE
           WHEN sync_run_step_fields.built_in = 1 THEN excluded.definition_json
           ELSE sync_run_step_fields.definition_json
         END`,
    ).run(seed.id, seed.label, JSON.stringify(seed.definition))
  }

  const kindRows = db
    .prepare(`SELECT id, definition_json FROM sync_run_kinds WHERE tenant_id = '_default'`)
    .all() as Array<{ id: string; definition_json: string }>

  const updateKind = db.prepare(
    `UPDATE sync_run_kinds SET definition_json = ? WHERE tenant_id = '_default' AND id = ?`,
  )
  for (const row of kindRows) {
    const migrated = migrateHandlerFromRefs(row.definition_json)
    if (migrated !== row.definition_json) {
      updateKind.run(migrated, row.id)
    }
  }

  for (const fieldId of STEP_FIELD_IDS) {
    db.prepare(
      `DELETE FROM sync_run_binding_sources
       WHERE tenant_id = '_default' AND id = ?
         AND definition_json LIKE '%"kind":"flowStepField"%'`,
    ).run(fieldId)
    db.prepare(
      `DELETE FROM sync_run_binding_sources
       WHERE tenant_id = '_default' AND id = ?
         AND definition_json LIKE '%"kind": "flowStepField"%'`,
    ).run(fieldId)
  }
}
