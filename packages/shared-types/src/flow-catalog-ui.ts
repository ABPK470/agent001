/**
 * Flow catalog helpers for authoring UI (step id pickers, prior-step output hints).
 */

import type { AuthoredSyncFlowStep } from "./index.js"

export {
  publishedOutputKeysForKind,
  publishedOutputKeysForStep,
  suggestPriorStepOutputKeys,
} from "./step-published-outputs.js"

export interface FlowStepPickerOption {
  value: string
  label: string
  hint?: string
}

export function collectKnownFlowStepIds(
  flows: ReadonlyArray<{ steps: readonly AuthoredSyncFlowStep[] }>,
  extraSteps: readonly AuthoredSyncFlowStep[] = [],
): string[] {
  const ids = new Set<string>()
  for (const flow of flows) {
    for (const step of flow.steps) {
      if (step.id?.trim()) ids.add(step.id.trim())
    }
  }
  for (const step of extraSteps) {
    if (step.id?.trim()) ids.add(step.id.trim())
  }
  return [...ids].sort()
}

export function flowStepPickerOptions(
  flows: ReadonlyArray<{ id: string; label: string; steps: readonly AuthoredSyncFlowStep[] }>,
  extraSteps: readonly AuthoredSyncFlowStep[] = [],
): FlowStepPickerOption[] {
  const byId = new Map<string, FlowStepPickerOption>()
  for (const flow of flows) {
    for (const step of flow.steps) {
      const id = step.id?.trim()
      if (!id || byId.has(id)) continue
      byId.set(id, {
        value: id,
        label: id,
        hint: `${flow.label} · kind ${step.kind}`,
      })
    }
  }
  for (const step of extraSteps) {
    const id = step.id?.trim()
    if (!id || byId.has(id)) continue
    byId.set(id, {
      value: id,
      label: id,
      hint: `kind ${step.kind}`,
    })
  }
  return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label))
}

/** @deprecated Step fields come from flow step bindings — returns field ids from bindings. */
export function catalogStepFieldIds(
  stepFields: Record<string, boolean> | undefined,
): string[] {
  return Object.entries(stepFields ?? {})
    .filter(([, required]) => required)
    .map(([fieldId]) => fieldId)
    .sort()
}
