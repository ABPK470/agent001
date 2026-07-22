/**
 * Publish-time validation for authored sync flow steps.
 */

import type {
  AuthoredSyncFlowStep,
  CustomValueSourceCatalog,
  SyncFlowKindDefinition,
  ValueSource,
} from "@mia/shared-types"
import {
  handlerInputSlots,
  isStepBoundHandlerSlot,
  kindAllowsEntityType,
  lookupCustomValueSource,
  METADATA_SYNC_KIND_ID,
  readStepFieldValue,
  requiredStepBoundSlotNames,
  stepFieldKeysForStep,
  validateValueSource,
} from "@mia/shared-types"

import type { FlowCatalog } from "./flow-catalog.js"

export interface SyncFlowValidationIssue {
  stepId?: string
  kind?: string
  message: string
}

export interface SyncFlowValidationResult {
  errors: SyncFlowValidationIssue[]
  warnings: SyncFlowValidationIssue[]
}

function isExecutableKind(kindDef: SyncFlowKindDefinition): boolean {
  const handler = kindDef.handler
  if (handler.type === "metadata_sync") return true
  if (handler.type === "http_request") {
    if (!handler.httpService?.trim() || !handler.httpPath?.trim()) return false
    const method = handler.httpMethod ?? "POST"
    if (method !== "GET" && handlerInputSlots(handler).length === 0) return false
    return true
  }
  if (handler.type === "custom_sql") {
    return Boolean(handler.sqlBatch?.trim())
  }
  if (handler.type === "custom_shell_script") {
    return Boolean(handler.shellCommand?.trim())
  }
  if (handler.type === "mssql_procedure") {
    return Boolean(handler.procedure?.trim())
  }
  return false
}

function validateValueSourceRef(
  source: ValueSource,
  catalog: CustomValueSourceCatalog,
  step: AuthoredSyncFlowStep,
  slotName: string,
  errors: SyncFlowValidationIssue[],
): void {
  const shapeError = validateValueSource(source)
  if (shapeError) {
    errors.push({ stepId: step.id, kind: step.kind, message: shapeError })
    return
  }
  if (source.type === "catalog") {
    try {
      lookupCustomValueSource(catalog, source.id)
    } catch (e) {
      errors.push({
        stepId: step.id,
        kind: step.kind,
        message:
          e instanceof Error
            ? e.message
            : `Step "${step.id}" binding "${slotName}" references unknown custom value source "${source.id}".`,
      })
    }
  }
}

function validateStepBindings(
  step: AuthoredSyncFlowStep,
  kindDef: SyncFlowKindDefinition,
  customCatalog: CustomValueSourceCatalog,
  errors: SyncFlowValidationIssue[],
): void {
  const slots = handlerInputSlots(kindDef.handler)
  for (const slot of slots) {
    if (slot.source) {
      validateValueSourceRef(slot.source, customCatalog, step, slot.name, errors)
    }
    if (!isStepBoundHandlerSlot(slot)) continue
    const slotName = slot.name.trim()
    const source = step.bindings?.[slotName]
    if (!source) {
      errors.push({
        stepId: step.id,
        kind: step.kind,
        message: `Step "${step.id}" requires binding "${slotName}" on the flow step.`,
      })
      continue
    }
    validateValueSourceRef(source, customCatalog, step, slotName, errors)
  }

  for (const field of stepFieldKeysForStep(step, kindDef)) {
    try {
      readStepFieldValue(step, field)
    } catch {
      errors.push({
        stepId: step.id,
        kind: step.kind,
        message: `Step "${step.id}" requires ${field}.`,
      })
    }
  }

  for (const slotName of requiredStepBoundSlotNames(kindDef.handler)) {
    if (step.bindings?.[slotName]) continue
    if (errors.some((e) => e.stepId === step.id && e.message.includes(`binding "${slotName}"`))) continue
    errors.push({
      stepId: step.id,
      kind: step.kind,
      message: `Step "${step.id}" requires binding "${slotName}" on the flow step.`,
    })
  }
}

export function validateAuthoredSyncFlow(
  steps: readonly AuthoredSyncFlowStep[],
  entityId: string,
  catalog: FlowCatalog,
  options?: { skipEntityTypeCheck?: boolean },
): SyncFlowValidationResult {
  const errors: SyncFlowValidationIssue[] = []
  const warnings: SyncFlowValidationIssue[] = []
  const customCatalog = catalog.resolveCustomValueSourceCatalog()

  if (steps.length === 0) {
    errors.push({ message: "Execution flow must include at least one step." })
    return { errors, warnings }
  }

  const metadataIndexes = steps
    .map((step, index) => (step.kind === METADATA_SYNC_KIND_ID ? index : -1))
    .filter((index) => index >= 0)

  if (metadataIndexes.length !== 1) {
    errors.push({
      message: `Flow must include exactly one ${METADATA_SYNC_KIND_ID} step (found ${metadataIndexes.length}).`,
    })
    return { errors, warnings }
  }

  const metadataIndex = metadataIndexes[0]!

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]!
    const kindDef = catalog.resolveKind(step.kind)
    if (!kindDef) {
      errors.push({ stepId: step.id, kind: step.kind, message: `Unknown step kind "${step.kind}".` })
      continue
    }
    if (!options?.skipEntityTypeCheck && !kindAllowsEntityType(kindDef.entityTypes, entityId)) {
      errors.push({
        stepId: step.id,
        kind: step.kind,
        message: `Kind "${step.kind}" is not allowed for entity type "${entityId}".`,
      })
    }
    if (!isExecutableKind(kindDef)) {
      errors.push({
        stepId: step.id,
        kind: step.kind,
        message: `Kind "${step.kind}" has no executable handler (procedure, HTTP path, SQL batch, or shell command).`,
      })
    }

    if (index < metadataIndex && step.kind === METADATA_SYNC_KIND_ID) {
      errors.push({
        stepId: step.id,
        kind: step.kind,
        message: `${METADATA_SYNC_KIND_ID} must appear once in the flow.`,
      })
    }

    validateStepBindings(step, kindDef, customCatalog, errors)
  }

  return { errors, warnings }
}
