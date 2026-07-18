/**
 * Flow step persistence — single ingress for catalog id rules and flow validation.
 *
 * camelCase catalog ids only (`metadataSync`, not `metadata-sync`).
 * All writes and imports must pass through prepareFlowStepsForStorage.
 */

import type { AuthoredSyncFlowStep } from "@mia/shared-types"
import { validateCatalogId } from "@mia/shared-types"
import { buildFlowCatalog, validateAuthoredSyncFlow, type FlowCatalog } from "@mia/sync"

export class FlowStepsValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FlowStepsValidationError"
  }
}

export type SyncMetadataFlowDoc = {
  phases?: Array<{ id: string; label: string; sortOrder: number; definition: unknown }>
  actions?: Array<{ id: string; label: string; definition: unknown }>
  valueSources?: Array<{ id: string; label: string; definition: unknown }>
  /** @deprecated Prefer `actions` */
  stepTypes?: Array<{ id: string; label: string; definition: unknown }>
  /** @deprecated Prefer `valueSources` */
  customValueSources?: Array<{ id: string; label: string; definition: unknown }>
  flows?: Record<string, { label: string; description?: string; steps: AuthoredSyncFlowStep[] }>
}

function stripFlowStepPhase(steps: readonly AuthoredSyncFlowStep[]): AuthoredSyncFlowStep[] {
  return steps.map(({ phase: _phase, ...step }) => step)
}

export function assertFlowStepCatalogIds(steps: readonly AuthoredSyncFlowStep[]): void {
  for (const step of steps) {
    const stepIdError = validateCatalogId(step.id, "Step id")
    if (stepIdError) throw new FlowStepsValidationError(`Step: ${stepIdError}`)
    const kindIdError = validateCatalogId(step.kind, "Kind id")
    if (kindIdError) throw new FlowStepsValidationError(`Step "${step.id}": ${kindIdError}`)
  }
}

export function buildFlowCatalogFromSyncMetadataDoc(meta: SyncMetadataFlowDoc): FlowCatalog {
  const phases = (meta.phases ?? []).map((phase) => ({
    id: phase.id,
    label: phase.label,
    definition_json: JSON.stringify(phase.definition),
  }))
  const actions = meta.actions ?? meta.stepTypes ?? []
  const kinds = actions.map((kind) => ({
    id: kind.id,
    label: kind.label,
    definition_json: JSON.stringify(kind.definition),
  }))
  const wiring = (meta.valueSources ?? meta.customValueSources ?? []).map((source) => ({
    id: source.id,
    label: source.label,
    definition_json: JSON.stringify(source.definition),
  }))
  return buildFlowCatalog(phases, kinds, wiring)
}

export function validateFlowStepsForCatalog(
  steps: readonly AuthoredSyncFlowStep[],
  flowCatalog: FlowCatalog,
): string | null {
  try {
    assertFlowStepCatalogIds(steps)
  } catch (error) {
    return error instanceof FlowStepsValidationError ? error.message : String(error)
  }
  const validation = validateAuthoredSyncFlow(steps, "contract", flowCatalog, {
    skipEntityTypeCheck: true,
  })
  if (validation.errors.length === 0) return null
  return validation.errors.map((issue) => issue.message).join("; ")
}

export function prepareFlowStepsForStorage(
  steps: readonly AuthoredSyncFlowStep[],
  flowCatalog: FlowCatalog,
): AuthoredSyncFlowStep[] {
  const stripped = stripFlowStepPhase(steps)
  const error = validateFlowStepsForCatalog(stripped, flowCatalog)
  if (error) throw new FlowStepsValidationError(error)
  return stripped
}

export function parseStoredFlowStepsJson(json: string): AuthoredSyncFlowStep[] {
  const parsed = JSON.parse(json) as unknown
  if (!Array.isArray(parsed)) return []
  const steps = parsed as AuthoredSyncFlowStep[]
  assertFlowStepCatalogIds(steps)
  return steps
}

export function serializeFlowStepsJson(
  steps: readonly AuthoredSyncFlowStep[],
  flowCatalog: FlowCatalog,
): string {
  return JSON.stringify(prepareFlowStepsForStorage(steps, flowCatalog))
}
