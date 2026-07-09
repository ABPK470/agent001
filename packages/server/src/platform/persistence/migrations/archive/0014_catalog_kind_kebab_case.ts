import type Database from "better-sqlite3"

const LEGACY_KIND_ID_MAP: Record<string, string> = {
  metadataSync: "metadata-sync",
  auditCheck: "audit-check",
  targetLock: "target-lock",
  targetUnlock: "target-unlock",
  contractUndeploy: "contract-undeploy",
  contractPreScript: "contract-pre-script",
  contractCreateStageDataset: "contract-create-stage-dataset",
  contractCreateArchiveDataset: "contract-create-archive-dataset",
  contractCreateListDataset: "contract-create-list-dataset",
  contractCreateDimDataset: "contract-create-dim-dataset",
  contractCreateFactDataset: "contract-create-fact-dataset",
  contractCreateDatasetFks: "contract-create-dataset-fks",
  contractDeployEtl: "contract-deploy-etl",
  contractDeployRoutine: "contract-deploy-routine",
  contractPostScript: "contract-post-script",
  datasetDeploy: "dataset-deploy",
  rulesDeploy: "rules-deploy",
  pipelineRegister: "pipeline-register",
  metaRefresh: "meta-refresh",
  pipelineStart: "pipeline-start",
  handleDependencies: "handle-dependencies",
  syncDate: "sync-date",
  deployDate: "deploy-date",
}

const LEGACY_RESOLVER_ID_MAP: Record<string, string> = {
  entityId: "entity-id",
  contractName: "contract-name",
  auditObjectType: "audit-object-type",
  objectName: "object-name",
  pipelineName: "pipeline-name",
  subjectRef: "subject-ref",
  stepId: "step-id",
  planActor: "plan-actor",
}

function normalizeLegacyCatalogId(id: string, map: Record<string, string>): string {
  return map[id] ?? id
}

function migrateJsonText(json: string): string {
  let next = json
  for (const [from, to] of Object.entries(LEGACY_KIND_ID_MAP)) {
    next = next.split(`"${from}"`).join(`"${to}"`)
  }
  for (const [from, to] of Object.entries(LEGACY_RESOLVER_ID_MAP)) {
    next = next.split(`"from":"${from}"`).join(`"from":"${to}"`)
    next = next.split(`"from": "${from}"`).join(`"from": "${to}"`)
  }
  return next
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
  ).run(to, row.label, row.built_in, migrateJsonText(row.definition_json))

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
  ).run(to, row.label, row.built_in, migrateJsonText(row.definition_json))

  db.prepare(`DELETE FROM sync_run_binding_sources WHERE tenant_id = '_default' AND id = ?`).run(from)
}

function migrateStepsJson(stepsJson: string): string {
  try {
    const steps = JSON.parse(stepsJson) as Array<{ kind?: string; [key: string]: unknown }>
    if (!Array.isArray(steps)) return migrateJsonText(stepsJson)
    const migrated = steps.map((step) =>
      step && typeof step === "object" && typeof step.kind === "string"
        ? { ...step, kind: normalizeLegacyCatalogId(step.kind, LEGACY_KIND_ID_MAP) }
        : step,
    )
    return migrateJsonText(JSON.stringify(migrated))
  } catch {
    return migrateJsonText(stepsJson)
  }
}

export function runCatalogKindKebabCaseMigration(db: Database.Database): void {
  for (const [from, to] of Object.entries(LEGACY_KIND_ID_MAP)) {
    renameKindRow(db, from, to)
  }

  for (const [from, to] of Object.entries(LEGACY_RESOLVER_ID_MAP)) {
    renameResolverRow(db, from, to)
  }

  const presetRows = db
    .prepare(`SELECT id, steps_json FROM sync_run_presets WHERE tenant_id = '_default'`)
    .all() as Array<{ id: string; steps_json: string }>

  for (const row of presetRows) {
    const migrated = migrateStepsJson(row.steps_json)
    if (migrated !== row.steps_json) {
      db.prepare(`UPDATE sync_run_presets SET steps_json = ? WHERE tenant_id = '_default' AND id = ?`).run(
        migrated,
        row.id,
      )
    }
  }

  const configRows = db
    .prepare(`SELECT entity_id, execution_steps_json FROM sync_definition_configs WHERE tenant_id = '_default'`)
    .all() as Array<{ entity_id: string; execution_steps_json: string }>

  for (const row of configRows) {
    const migrated = migrateStepsJson(row.execution_steps_json)
    if (migrated !== row.execution_steps_json) {
      db.prepare(
        `UPDATE sync_definition_configs SET execution_steps_json = ? WHERE tenant_id = '_default' AND entity_id = ?`,
      ).run(migrated, row.entity_id)
    }
  }
}
