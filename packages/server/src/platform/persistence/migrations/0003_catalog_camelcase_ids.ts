/**
 * One-time scrub: reverse archived kebab-case catalog ids back to canonical camelCase.
 *
 * Runtime code never normalizes legacy ids — this migration fixes SQLite + version snapshots.
 */

import type Database from "better-sqlite3"

const KEBAB_TO_CAMEL_KIND_IDS: Record<string, string> = {
  "metadata-sync": "metadataSync",
  "audit-check": "auditCheck",
  "target-lock": "targetLock",
  "target-unlock": "targetUnlock",
  "contract-undeploy": "contractUndeploy",
  "contract-pre-script": "contractPreScript",
  "contract-create-stage-dataset": "contractCreateStageDataset",
  "contract-create-archive-dataset": "contractCreateArchiveDataset",
  "contract-create-list-dataset": "contractCreateListDataset",
  "contract-create-dim-dataset": "contractCreateDimDataset",
  "contract-create-fact-dataset": "contractCreateFactDataset",
  "contract-create-dataset-fks": "contractCreateDatasetFks",
  "contract-deploy-etl": "contractDeployEtl",
  "contract-deploy-routine": "contractDeployRoutine",
  "contract-post-script": "contractPostScript",
  "dataset-deploy": "datasetDeploy",
  "rules-deploy": "rulesDeploy",
  "pipeline-register": "pipelineRegister",
  "meta-refresh": "metaRefresh",
  "pipeline-start": "pipelineStart",
  "handle-dependencies": "handleDependencies",
  "sync-date": "syncDate",
  "deploy-date": "deployDate",
}

const KEBAB_TO_CAMEL_RESOLVER_IDS: Record<string, string> = {
  "entity-id": "entityId",
  "contract-name": "contractName",
  "audit-object-type": "auditObjectType",
  "object-name": "objectName",
  "pipeline-name": "pipelineName",
  "subject-ref": "subjectRef",
  "step-id": "stepId",
  "plan-actor": "planActor",
}

function rewriteCatalogJsonText(json: string): string {
  let next = json
  for (const [from, to] of Object.entries(KEBAB_TO_CAMEL_KIND_IDS)) {
    next = next.split(`"${from}"`).join(`"${to}"`)
  }
  for (const [from, to] of Object.entries(KEBAB_TO_CAMEL_RESOLVER_IDS)) {
    next = next.split(`"from":"${from}"`).join(`"from":"${to}"`)
    next = next.split(`"from": "${from}"`).join(`"from": "${to}"`)
  }
  return next
}

function migrateStepsJson(stepsJson: string): string {
  try {
    const steps = JSON.parse(stepsJson) as Array<{ kind?: string; id?: string; [key: string]: unknown }>
    if (!Array.isArray(steps)) return rewriteCatalogJsonText(stepsJson)
    const migrated = steps.map((step) => {
      if (!step || typeof step !== "object") return step
      const next = { ...step }
      if (typeof step.kind === "string") {
        next.kind = KEBAB_TO_CAMEL_KIND_IDS[step.kind] ?? step.kind
      }
      if (typeof step.id === "string") {
        next.id = KEBAB_TO_CAMEL_KIND_IDS[step.id] ?? step.id
      }
      return next
    })
    return rewriteCatalogJsonText(JSON.stringify(migrated))
  } catch {
    return rewriteCatalogJsonText(stepsJson)
  }
}

function renameKindRow(db: Database.Database, from: string, to: string): void {
  const row = db
    .prepare(
      `SELECT label, built_in, definition_json FROM sync_run_kinds WHERE tenant_id = '_default' AND id = ?`,
    )
    .get(from) as { label: string; built_in: number; definition_json: string } | undefined
  if (!row) return

  const targetExists = db
    .prepare(`SELECT 1 AS ok FROM sync_run_kinds WHERE tenant_id = '_default' AND id = ?`)
    .get(to) as { ok: number } | undefined

  if (targetExists) {
    db.prepare(`DELETE FROM sync_run_kinds WHERE tenant_id = '_default' AND id = ?`).run(from)
    return
  }

  db.prepare(
    `INSERT INTO sync_run_kinds (tenant_id, id, label, built_in, definition_json)
     VALUES ('_default', ?, ?, ?, ?)`,
  ).run(to, row.label, row.built_in, rewriteCatalogJsonText(row.definition_json))
  db.prepare(`DELETE FROM sync_run_kinds WHERE tenant_id = '_default' AND id = ?`).run(from)
}

function renameResolverRow(db: Database.Database, from: string, to: string): void {
  const row = db
    .prepare(
      `SELECT label, built_in, definition_json FROM sync_run_binding_sources WHERE tenant_id = '_default' AND id = ?`,
    )
    .get(from) as { label: string; built_in: number; definition_json: string } | undefined
  if (!row) return

  const targetExists = db
    .prepare(`SELECT 1 AS ok FROM sync_run_binding_sources WHERE tenant_id = '_default' AND id = ?`)
    .get(to) as { ok: number } | undefined

  if (targetExists) {
    db.prepare(`DELETE FROM sync_run_binding_sources WHERE tenant_id = '_default' AND id = ?`).run(from)
    return
  }

  db.prepare(
    `INSERT INTO sync_run_binding_sources (tenant_id, id, label, built_in, definition_json)
     VALUES ('_default', ?, ?, ?, ?)`,
  ).run(to, row.label, row.built_in, rewriteCatalogJsonText(row.definition_json))
  db.prepare(`DELETE FROM sync_run_binding_sources WHERE tenant_id = '_default' AND id = ?`).run(from)
}

function migrateCatalogVersionSnapshots(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS sync_catalog_versions_no_update;
    DROP TRIGGER IF EXISTS sync_catalog_versions_no_delete;
  `)

  const rows = db
    .prepare(`SELECT tenant_id, version, snapshot_json FROM sync_catalog_versions`)
    .all() as Array<{ tenant_id: string; version: number; snapshot_json: string }>

  const update = db.prepare(
    `UPDATE sync_catalog_versions SET snapshot_json = ? WHERE tenant_id = ? AND version = ?`,
  )

  for (const row of rows) {
    const migrated = rewriteCatalogJsonText(row.snapshot_json)
    if (migrated !== row.snapshot_json) {
      update.run(migrated, row.tenant_id, row.version)
    }
  }

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS sync_catalog_versions_no_update
    BEFORE UPDATE ON sync_catalog_versions
    BEGIN
      SELECT RAISE(ABORT, 'sync_catalog_versions is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS sync_catalog_versions_no_delete
    BEFORE DELETE ON sync_catalog_versions
    BEGIN
      SELECT RAISE(ABORT, 'sync_catalog_versions is append-only');
    END;
  `)
}

export function runCatalogCamelcaseIdsMigration(db: Database.Database): void {
  for (const [from, to] of Object.entries(KEBAB_TO_CAMEL_KIND_IDS)) {
    renameKindRow(db, from, to)
  }
  for (const [from, to] of Object.entries(KEBAB_TO_CAMEL_RESOLVER_IDS)) {
    renameResolverRow(db, from, to)
  }

  const presetRows = db
    .prepare(`SELECT id, steps_json FROM sync_run_presets`)
    .all() as Array<{ id: string; steps_json: string }>
  const updatePreset = db.prepare(`UPDATE sync_run_presets SET steps_json = ? WHERE tenant_id = '_default' AND id = ?`)
  for (const row of presetRows) {
    const migrated = migrateStepsJson(row.steps_json)
    if (migrated !== row.steps_json) updatePreset.run(migrated, row.id)
  }

  const configRows = db
    .prepare(`SELECT entity_id, execution_steps_json FROM sync_definition_configs`)
    .all() as Array<{ entity_id: string; execution_steps_json: string }>
  const updateConfig = db.prepare(
    `UPDATE sync_definition_configs SET execution_steps_json = ? WHERE tenant_id = '_default' AND entity_id = ?`,
  )
  for (const row of configRows) {
    const migrated = migrateStepsJson(row.execution_steps_json)
    if (migrated !== row.execution_steps_json) updateConfig.run(migrated, row.entity_id)
  }

  migrateCatalogVersionSnapshots(db)
}
