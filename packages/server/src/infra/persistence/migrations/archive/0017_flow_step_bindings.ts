import type Database from "better-sqlite3"

import { BUILTIN_PLAN_BINDING_SOURCE_SEEDS } from "@mia/shared-types"

const SUBJECT_TO_BINDING_SLOT: Record<string, { slot: string; source: string }> = {
  "dataset-deploy": { slot: "datasetId", source: "entity-id" },
  "pipeline-register": { slot: "pipelineId", source: "contract-pipeline-id" },
}

const FLOW_STEP_FIELD_TO_BINDING: Record<string, Record<string, string>> = {
  "audit-check": { objType: "flow-step-field:audit-object-type" },
  "sync-date": { objType: "flow-step-field:audit-object-type" },
  "deploy-date": { objType: "flow-step-field:audit-object-type" },
  "handle-dependencies": { objectName: "flow-step-field:object-name" },
  "pipeline-start": { name: "flow-step-field:pipeline-name" },
}

function migrateKindDefinition(def: Record<string, unknown>): Record<string, unknown> {
  const handler = def.handler as Record<string, unknown> | undefined
  if (!handler) return { ...def, stepFields: {} }

  for (const key of ["parameters", "httpBody", "inputs"] as const) {
    const slots = handler[key] as Array<Record<string, unknown>> | undefined
    if (!slots) continue
    handler[key] = slots.map((slot) => {
      const from = typeof slot.from === "string" ? slot.from.trim() : ""
      if (from === "subject-ref") {
        const { from: _removed, ...rest } = slot
        return rest
      }
      if (from.startsWith("flow-step-field:")) {
        const { from: _removed, ...rest } = slot
        return rest
      }
      return slot
    })
  }

  return { ...def, stepFields: {} }
}

function migrateFlowStep(step: Record<string, unknown>): Record<string, unknown> {
  const kind = String(step.kind ?? "")
  const bindings: Record<string, string> = {
    ...(typeof step.bindings === "object" && step.bindings !== null
      ? (step.bindings as Record<string, string>)
      : {}),
  }

  const subjectResolverId =
    typeof step.subjectResolverId === "string" ? step.subjectResolverId.trim() : ""
  if (subjectResolverId) {
    if (kind === "dataset-deploy") bindings.datasetId = subjectResolverId
    else if (kind === "pipeline-register") bindings.pipelineId = subjectResolverId
  }

  const defaults = FLOW_STEP_FIELD_TO_BINDING[kind]
  if (defaults) {
    for (const [slot, source] of Object.entries(defaults)) {
      if (!bindings[slot]) bindings[slot] = source
    }
  }

  if (kind === "dataset-deploy" && !bindings.datasetId) {
    bindings.datasetId = "entity-id"
  }
  if (kind === "pipeline-register" && !bindings.pipelineId) {
    bindings.pipelineId = "contract-pipeline-id"
  }

  const { subjectResolverId: _removed, subjectRef: _legacy, ...rest } = step
  return { ...rest, bindings }
}

function migrateStepsJson(json: string): string {
  const parsed = JSON.parse(json) as unknown
  if (!Array.isArray(parsed)) return json
  return JSON.stringify(parsed.map((step) => migrateFlowStep(step as Record<string, unknown>)))
}

export function runFlowStepBindingsMigration(db: Database.Database): void {
  for (const seed of BUILTIN_PLAN_BINDING_SOURCE_SEEDS) {
    db.prepare(
      `INSERT INTO sync_run_binding_sources (tenant_id, id, label, built_in, definition_json)
       VALUES ('_default', ?, ?, 1, ?)
       ON CONFLICT(tenant_id, id) DO UPDATE SET
         label = excluded.label,
         definition_json = CASE
           WHEN sync_run_binding_sources.built_in = 1 THEN excluded.definition_json
           ELSE sync_run_binding_sources.definition_json
         END`,
    ).run(seed.id, seed.label, JSON.stringify(seed.definition))
  }

  db.prepare(`DELETE FROM sync_run_binding_sources WHERE tenant_id = '_default' AND id = 'subject-ref'`).run()

  const kindRows = db
    .prepare(`SELECT id, definition_json FROM sync_run_kinds WHERE tenant_id = '_default'`)
    .all() as Array<{ id: string; definition_json: string }>
  const updateKind = db.prepare(
    `UPDATE sync_run_kinds SET definition_json = ? WHERE tenant_id = '_default' AND id = ?`,
  )
  for (const row of kindRows) {
    const def = migrateKindDefinition(JSON.parse(row.definition_json) as Record<string, unknown>)
    updateKind.run(JSON.stringify(def), row.id)
  }

  const presetRows = db
    .prepare(`SELECT id, steps_json FROM sync_run_presets WHERE tenant_id = '_default'`)
    .all() as Array<{ id: string; steps_json: string }>
  const updatePreset = db.prepare(
    `UPDATE sync_run_presets SET steps_json = ? WHERE tenant_id = '_default' AND id = ?`,
  )
  for (const row of presetRows) {
    updatePreset.run(migrateStepsJson(row.steps_json), row.id)
  }

  const configRows = db
    .prepare(`SELECT entity_id, execution_steps_json FROM sync_definition_configs WHERE tenant_id = '_default'`)
    .all() as Array<{ entity_id: string; execution_steps_json: string | null }>
  const updateConfig = db.prepare(
    `UPDATE sync_definition_configs SET execution_steps_json = ? WHERE tenant_id = '_default' AND entity_id = ?`,
  )
  for (const row of configRows) {
    if (!row.execution_steps_json?.trim()) continue
    updateConfig.run(migrateStepsJson(row.execution_steps_json), row.entity_id)
  }

  db.exec(`DROP TABLE IF EXISTS sync_run_subject_resolvers`)
}
