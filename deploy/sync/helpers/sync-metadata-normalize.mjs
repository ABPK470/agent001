/**
 * Normalize derived sync metadata to the current catalog model:
 * step-field routing on handler slots via ValueSource; flow bindings only for per-flow value sources.
 */

/** kind id → slot name → stepField ValueSource on the action */
const TEXT_FIELD_ON_ACTION = {
  auditCheck: { objType: { type: "stepField", field: "auditObjectType" } },
  syncDate: { objType: { type: "stepField", field: "auditObjectType" } },
  deployDate: { objType: { type: "stepField", field: "auditObjectType" } },
  handleDependencies: { objectName: { type: "stepField", field: "objectName" } },
  pipelineStart: { name: { type: "stepField", field: "pipelineName" } },
}

function isStepFieldSource(value) {
  return value && typeof value === "object" && value.type === "stepField"
}

function applyTextFieldsToHandler(handler, kindId) {
  if (!handler || typeof handler !== "object") return handler
  const textSlots = TEXT_FIELD_ON_ACTION[kindId]
  if (!textSlots) return handler
  const next = { ...handler }
  for (const key of ["parameters", "httpBody", "inputs"]) {
    const slots = next[key]
    if (!Array.isArray(slots)) continue
    next[key] = slots.map((slot) => {
      if (!slot || typeof slot !== "object") return slot
      const name = typeof slot.name === "string" ? slot.name.trim() : ""
      const textSource = textSlots[name]
      if (!textSource || slot.source) return slot
      return { ...slot, source: textSource }
    })
  }
  return next
}

export function migrateKindDefinition(def, kindId) {
  if (!def || typeof def !== "object") return def
  const next = { ...def }
  if (next.handler) {
    next.handler = applyTextFieldsToHandler(next.handler, kindId)
  }
  delete next.stepFields
  return next
}

export function migrateFlowStep(step) {
  if (!step || typeof step !== "object") return step
  const bindings = {}
  if (typeof step.bindings === "object" && step.bindings !== null) {
    for (const [slot, value] of Object.entries(step.bindings)) {
      if (isStepFieldSource(value)) continue
      bindings[slot] = value
    }
  }
  const { bindings: _removed, stepFields: _sf, ...rest } = step
  if (Object.keys(bindings).length === 0) return rest
  return { ...rest, bindings }
}
