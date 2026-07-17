import type Database from "better-sqlite3"

/** Reverse migration 0012 — entity registry ids back to camelCase domain names. */
const RENAMES: Record<string, string> = {
  "gate-metadata": "gateMetadata",
  "pipeline-activity": "pipelineActivity",
}

function migrateJsonText(json: string): string {
  let next = json
  for (const [from, to] of Object.entries(RENAMES)) {
    next = next.split(`"${from}"`).join(`"${to}"`)
  }
  return next
}

function dropEntityDefVersionTriggers(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS entity_def_versions_no_update;
    DROP TRIGGER IF EXISTS entity_def_versions_no_delete;
  `)
}

function restoreEntityDefVersionTriggers(db: Database.Database): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS entity_def_versions_no_update
      BEFORE UPDATE ON entity_def_versions
      BEGIN SELECT RAISE(ABORT, 'entity_def_versions is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS entity_def_versions_no_delete
      BEFORE DELETE ON entity_def_versions
      BEGIN SELECT RAISE(ABORT, 'entity_def_versions is append-only'); END;
  `)
}

function renameEntityDefRows(db: Database.Database, from: string, to: string): void {
  const source = db
    .prepare(`SELECT current_version, retired_at FROM entity_defs WHERE tenant_id = '_default' AND id = ?`)
    .get(from) as { current_version: number; retired_at: string | null } | undefined

  if (!source) return

  const targetExists = db
    .prepare(`SELECT 1 AS ok FROM entity_defs WHERE tenant_id = '_default' AND id = ?`)
    .get(to) as { ok: number } | undefined

  if (targetExists) return

  const versions = db
    .prepare(
      `SELECT version, body_json, version_label, created_by, created_at, reason, diff_json
       FROM entity_def_versions WHERE tenant_id = '_default' AND id = ? ORDER BY version`,
    )
    .all(from) as Array<{
      version: number
      body_json: string
      version_label: string | null
      created_by: string
      created_at: string
      reason: string
      diff_json: string
    }>

  for (const row of versions) {
    db.prepare(
      `INSERT INTO entity_def_versions
        (tenant_id, id, version, body_json, version_label, created_by, created_at, reason, diff_json)
       VALUES ('_default', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      to,
      row.version,
      migrateJsonText(row.body_json),
      row.version_label,
      row.created_by,
      row.created_at,
      row.reason,
      migrateJsonText(row.diff_json),
    )
  }

  db.prepare(`DELETE FROM entity_def_versions WHERE tenant_id = '_default' AND id = ?`).run(from)

  db.prepare(
    `INSERT INTO entity_defs (tenant_id, id, current_version, retired_at) VALUES ('_default', ?, ?, ?)`,
  ).run(to, source.current_version, source.retired_at)

  db.prepare(`DELETE FROM entity_defs WHERE tenant_id = '_default' AND id = ?`).run(from)
}

function renamePresetRow(db: Database.Database, from: string, to: string): void {
  const row = db
    .prepare(
      `SELECT label, description, steps_json, built_in, updated_at, updated_by
       FROM sync_run_presets WHERE tenant_id = '_default' AND id = ?`,
    )
    .get(from) as
    | {
        label: string
        description: string
        steps_json: string
        built_in: number
        updated_at: string
        updated_by: string | null
      }
    | undefined

  if (!row) return

  const targetExists = db
    .prepare(`SELECT 1 AS ok FROM sync_run_presets WHERE tenant_id = '_default' AND id = ?`)
    .get(to) as { ok: number } | undefined

  if (targetExists) {
    db.prepare(`DELETE FROM sync_run_presets WHERE tenant_id = '_default' AND id = ?`).run(from)
    return
  }

  db.prepare(
    `INSERT INTO sync_run_presets (tenant_id, id, label, description, steps_json, built_in, updated_at, updated_by)
     VALUES ('_default', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    to,
    row.label,
    row.description,
    migrateJsonText(row.steps_json),
    row.built_in,
    row.updated_at,
    row.updated_by,
  )

  db.prepare(`DELETE FROM sync_run_presets WHERE tenant_id = '_default' AND id = ?`).run(from)
}

function updateKindDefinitions(db: Database.Database): void {
  const kinds = db
    .prepare(`SELECT id, definition_json FROM sync_run_kinds WHERE tenant_id = '_default'`)
    .all() as Array<{ id: string; definition_json: string }>

  for (const kind of kinds) {
    const migrated = migrateJsonText(kind.definition_json)
    if (migrated !== kind.definition_json) {
      db.prepare(
        `UPDATE sync_run_kinds SET definition_json = ? WHERE tenant_id = '_default' AND id = ?`,
      ).run(migrated, kind.id)
    }
  }
}

function updateEntityTypeColumns(db: Database.Database, table: string, column: string): void {
  for (const [from, to] of Object.entries(RENAMES)) {
    db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(to, from)
  }
}

export function runEntityIdCamelCaseRevertMigration(db: Database.Database): void {
  dropEntityDefVersionTriggers(db)

  try {
    for (const [from, to] of Object.entries(RENAMES)) {
      renameEntityDefRows(db, from, to)
      renamePresetRow(db, from, to)
    }

    updateKindDefinitions(db)
    updateEntityTypeColumns(db, "sync_runs", "entity_type")
    updateEntityTypeColumns(db, "sync_proposals", "entity_type")
  } finally {
    restoreEntityDefVersionTriggers(db)
  }
}
