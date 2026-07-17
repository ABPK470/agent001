import type Database from "better-sqlite3"

/** Historical migration — 0017 drops sync_run_subject_resolvers and moves wiring to flow step bindings. */
const LEGACY_SUBJECT_RESOLVER_SEEDS = [
  {
    id: "entity-id",
    label: "Plan entity id",
    definition: {
      description: "Numeric id of the entity being synced.",
      resolver: { kind: "entity-id" },
    },
  },
  {
    id: "rule-input-dataset-id",
    label: "Rule input dataset id",
    definition: {
      description: "inputDatasetId from core.Rule for the synced rule.",
      resolver: { kind: "entity-id" },
    },
  },
  {
    id: "contract-pipeline-id",
    label: "Contract pipeline id",
    definition: {
      description: "pipelineId from core.Pipeline for the synced contract.",
      resolver: { kind: "entity-id" },
    },
  },
] as const

function migrateLegacySubjectRef(legacy: string): string {
  switch (legacy) {
    case "entityId":
      return "entity-id"
    case "ruleInputDatasetId":
      return "rule-input-dataset-id"
    case "contractPipelineId":
      return "contract-pipeline-id"
    default:
      return legacy
  }
}

function migrateKindStepFields(json: string): string {
  return json
    .split('"subjectRef":true').join('"subject-resolver":true')
    .split('"subjectRef": true').join('"subject-resolver": true')
}

function migrateFlowStep(json: string): string {
  let next = json
  const legacyPattern = /"subjectRef"\s*:\s*"(entityId|ruleInputDatasetId|contractPipelineId)"/g
  next = next.replace(legacyPattern, (_match, legacy: string) => {
    const catalogId = migrateLegacySubjectRef(legacy)
    return `"subjectResolverId":"${catalogId}"`
  })
  return next
}

export function runSyncSubjectResolversMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_run_subject_resolvers (
      tenant_id        TEXT NOT NULL,
      id               TEXT NOT NULL,
      label            TEXT NOT NULL,
      built_in         INTEGER NOT NULL DEFAULT 0,
      definition_json  TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (tenant_id, id)
    );
  `)

  for (const seed of LEGACY_SUBJECT_RESOLVER_SEEDS) {
    db.prepare(
      `INSERT INTO sync_run_subject_resolvers (tenant_id, id, label, built_in, definition_json)
       VALUES ('_default', ?, ?, 1, ?)
       ON CONFLICT(tenant_id, id) DO UPDATE SET
         label = excluded.label,
         definition_json = CASE
           WHEN sync_run_subject_resolvers.built_in = 1 THEN excluded.definition_json
           ELSE sync_run_subject_resolvers.definition_json
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
    const migrated = migrateKindStepFields(row.definition_json)
    if (migrated !== row.definition_json) updateKind.run(migrated, row.id)
  }

  const presetRows = db
    .prepare(`SELECT id, steps_json FROM sync_run_presets WHERE tenant_id = '_default'`)
    .all() as Array<{ id: string; steps_json: string }>
  const updatePreset = db.prepare(
    `UPDATE sync_run_presets SET steps_json = ? WHERE tenant_id = '_default' AND id = ?`,
  )
  for (const row of presetRows) {
    const migrated = migrateFlowStep(row.steps_json)
    if (migrated !== row.steps_json) updatePreset.run(migrated, row.id)
  }

  const configRows = db
    .prepare(`SELECT entity_id, execution_steps_json FROM sync_definition_configs WHERE tenant_id = '_default'`)
    .all() as Array<{ entity_id: string; execution_steps_json: string | null }>
  const updateConfig = db.prepare(
    `UPDATE sync_definition_configs SET execution_steps_json = ? WHERE tenant_id = '_default' AND entity_id = ?`,
  )
  for (const row of configRows) {
    if (!row.execution_steps_json?.trim()) continue
    const migrated = migrateFlowStep(row.execution_steps_json)
    if (migrated !== row.execution_steps_json) updateConfig.run(migrated, row.entity_id)
  }
}
