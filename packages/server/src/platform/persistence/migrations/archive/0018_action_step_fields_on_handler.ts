import type Database from "better-sqlite3"

const TEXT_FIELD_ON_ACTION: Record<string, Record<string, string>> = {
  "audit-check": { objType: "flow-step-field:audit-object-type" },
  "sync-date": { objType: "flow-step-field:audit-object-type" },
  "deploy-date": { objType: "flow-step-field:audit-object-type" },
  "handle-dependencies": { objectName: "flow-step-field:object-name" },
  "pipeline-start": { name: "flow-step-field:pipeline-name" },
}

function applyTextFieldsToHandler(
  handler: Record<string, unknown>,
  kindId: string,
): Record<string, unknown> {
  const textSlots = TEXT_FIELD_ON_ACTION[kindId]
  if (!textSlots) return handler
  const next = { ...handler }
  for (const key of ["parameters", "httpBody", "inputs"] as const) {
    const slots = next[key] as Array<Record<string, unknown>> | undefined
    if (!Array.isArray(slots)) continue
    next[key] = slots.map((slot) => {
      const name = typeof slot.name === "string" ? slot.name.trim() : ""
      const textFrom = textSlots[name]
      if (!textFrom || slot.from || slot.value !== undefined) return slot
      return { ...slot, from: textFrom }
    })
  }
  return next
}

function migrateKindDefinition(
  def: Record<string, unknown>,
  kindId: string,
): Record<string, unknown> {
  const next = { ...def }
  if (next.handler && typeof next.handler === "object") {
    next.handler = applyTextFieldsToHandler(next.handler as Record<string, unknown>, kindId)
  }
  delete next.stepFields
  return next
}

function migrateFlowStep(step: Record<string, unknown>): Record<string, unknown> {
  const bindings: Record<string, string> = {}
  if (typeof step.bindings === "object" && step.bindings !== null) {
    for (const [slot, value] of Object.entries(step.bindings as Record<string, string>)) {
      if (typeof value === "string" && value.trim().startsWith("flow-step-field:")) continue
      bindings[slot] = value
    }
  }
  const { bindings: _removed, stepFields: _sf, ...rest } = step
  if (Object.keys(bindings).length === 0) return rest
  return { ...rest, bindings }
}

function migrateStepsJson(json: string): string {
  const parsed = JSON.parse(json) as unknown
  if (!Array.isArray(parsed)) return json
  return JSON.stringify(parsed.map((step) => migrateFlowStep(step as Record<string, unknown>)))
}

export function runActionStepFieldsMigration(db: Database.Database): void {
  const kindRows = db
    .prepare(`SELECT id, definition_json FROM sync_run_kinds WHERE tenant_id = '_default'`)
    .all() as Array<{ id: string; definition_json: string }>
  const updateKind = db.prepare(
    `UPDATE sync_run_kinds SET definition_json = ? WHERE tenant_id = '_default' AND id = ?`,
  )
  for (const row of kindRows) {
    const def = migrateKindDefinition(JSON.parse(row.definition_json) as Record<string, unknown>, row.id)
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
}
