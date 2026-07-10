/**
 * Normalize derived sync metadata to the current catalog model:
 * step-field routing on handler slots via ValueSource; flow bindings only for per-flow value sources.
 */

/** kind id → slot name → catalog id on the action */
const TEXT_FIELD_ON_ACTION = {
  auditCheck: { objType: "auditObjectType" },
  syncDate: { objType: "auditObjectType" },
  deployDate: { objType: "auditObjectType" },
  handleDependencies: { objectName: "objectName" },
  pipelineStart: { name: "pipelineName" },
}

const CATALOG_SHORTHAND_TYPES = new Set([
  "planEntityId",
  "planActor",
  "currentStepId",
  "contractName",
  "ruleInputDatasetId",
  "contractPipelineId",
])

function normalizeValueSourceRef(value) {
  if (!value || typeof value !== "object" || !value.type) return value
  if (value.type === "catalog" || value.type === "literal" || value.type === "priorOutput") return value
  if (value.type === "stepField" && typeof value.field === "string") {
    return { type: "catalog", id: value.field }
  }
  if (CATALOG_SHORTHAND_TYPES.has(value.type)) {
    return { type: "catalog", id: value.type }
  }
  return value
}

function normalizeHandlerSources(handler) {
  if (!handler || typeof handler !== "object") return handler
  const next = { ...handler }
  for (const key of ["parameters", "httpBody", "inputs"]) {
    const slots = next[key]
    if (!Array.isArray(slots)) continue
    next[key] = slots.map((slot) => {
      if (!slot || typeof slot !== "object" || !slot.source) return slot
      return { ...slot, source: normalizeValueSourceRef(slot.source) }
    })
  }
  return next
}

function isCatalogSource(value) {
  return value && typeof value === "object" && value.type === "catalog"
}

function applyTextFieldsToHandler(handler, kindId) {
  if (!handler || typeof handler !== "object") return handler
  const textSlots = TEXT_FIELD_ON_ACTION[kindId]
  if (!textSlots) return normalizeHandlerSources(handler)
  const next = normalizeHandlerSources(handler)
  for (const key of ["parameters", "httpBody", "inputs"]) {
    const slots = next[key]
    if (!Array.isArray(slots)) continue
    next[key] = slots.map((slot) => {
      if (!slot || typeof slot !== "object") return slot
      const name = typeof slot.name === "string" ? slot.name.trim() : ""
      const catalogId = textSlots[name]
      if (!catalogId || slot.source) return slot
      return { ...slot, source: { type: "catalog", id: catalogId } }
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
      const normalized = normalizeValueSourceRef(value)
      if (isCatalogSource(normalized)) {
        const fieldId = normalized.id
        if (["objectName", "auditObjectType", "pipelineName"].includes(fieldId)) continue
      }
      bindings[slot] = normalized
    }
  }
  const { bindings: _removed, stepFields: _sf, ...rest } = step
  if (Object.keys(bindings).length === 0) return rest
  return { ...rest, bindings }
}
