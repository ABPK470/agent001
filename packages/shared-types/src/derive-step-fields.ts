import type { SyncFlowKindDefinition } from "./index.js"
import { computePublishedOutputsForKind } from "./step-published-outputs.js"

/** Step field requirements are derived from flow step bindings, not kind definitions. */
export function deriveStepFields(
  _def: Pick<SyncFlowKindDefinition, "handler">,
): SyncFlowKindDefinition["stepFields"] {
  return {}
}

export function deriveStepFieldsFromHandler(): SyncFlowKindDefinition["stepFields"] {
  return {}
}

export function normalizeKindDefinition(
  def: SyncFlowKindDefinition,
  kindId?: string,
): SyncFlowKindDefinition {
  const publishedOutputs = computePublishedOutputsForKind(kindId, def)
  return {
    ...def,
    stepFields: {},
    ...(publishedOutputs.length > 0 ? { publishedOutputs: [...publishedOutputs] } : {}),
  }
}

export function requiredFlowStepFieldKeys(_def: SyncFlowKindDefinition): string[] {
  return []
}
