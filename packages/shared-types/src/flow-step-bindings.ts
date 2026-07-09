/**
 * Flow step bindings — per-step value source wiring.
 *
 * Kind handler slots are either:
 * - kind-fixed: `source` on the slot
 * - step-bound: no `source` — resolved via `step.bindings[slotName]`
 * - literal: `source: { type: "literal", value }`
 */

import type { AuthoredSyncFlowStep, SyncFlowKindHandler } from "./index.js"
import { handlerInputSlots, type SyncHandlerInput } from "./handler-input.js"
import type { SyncStepFieldKey, ValueSource } from "./value-source.js"
import {
  collectCatalogIdsFromValueSource,
  isLiteralValueSource,
  stepFieldKeysFromValueSource,
} from "./value-source.js"

export function isLiteralHandlerSlot(slot: SyncHandlerInput): boolean {
  return isLiteralValueSource(slot.source)
}

export function isKindFixedBindingSlot(slot: SyncHandlerInput): boolean {
  return slot.source !== undefined && !isLiteralValueSource(slot.source)
}

export function isStepBoundHandlerSlot(slot: SyncHandlerInput): boolean {
  const name = slot.name.trim()
  if (!name) return false
  return slot.source === undefined
}

export function requiredStepBoundSlotNames(handler: SyncFlowKindHandler): string[] {
  return handlerInputSlots(handler)
    .filter(isStepBoundHandlerSlot)
    .map((slot) => slot.name.trim())
    .filter(Boolean)
    .sort()
}

export function resolveSlotValueSource(
  slot: SyncHandlerInput,
  step: Pick<AuthoredSyncFlowStep, "id" | "bindings">,
): ValueSource {
  const name = slot.name.trim()
  if (slot.source !== undefined) {
    if (isLiteralValueSource(slot.source)) {
      throw new Error(`Internal error: literal slot "${name}" must not use resolveSlotValueSource.`)
    }
    return slot.source
  }
  const fromStep = step.bindings?.[name]
  if (!fromStep) {
    throw new Error(
      `Step "${step.id}" is missing binding for parameter "${name}". Set it on the flow step.`,
    )
  }
  return fromStep
}

export function stepFieldKeysFromHandler(handler: SyncFlowKindHandler): SyncStepFieldKey[] {
  const keys = new Set<SyncStepFieldKey>()
  for (const slot of handlerInputSlots(handler)) {
    for (const key of stepFieldKeysFromValueSource(slot.source)) keys.add(key)
  }
  return [...keys].sort()
}

/** Required step field keys — from handler slot wiring. */
export function stepFieldKeysForStep(
  step: Pick<AuthoredSyncFlowStep, "bindings">,
  kindDef: { handler: SyncFlowKindHandler } | undefined,
): SyncStepFieldKey[] {
  const keys = new Set<SyncStepFieldKey>()
  if (kindDef) {
    for (const key of stepFieldKeysFromHandler(kindDef.handler)) keys.add(key)
  }
  return [...keys].sort()
}

export function collectCatalogIdsFromFlowSteps(
  steps: readonly Pick<AuthoredSyncFlowStep, "kind" | "bindings">[],
  kinds: Record<string, { handler?: SyncFlowKindHandler }>,
): string[] {
  const ids = new Set<string>()
  for (const step of steps) {
    const kind = kinds[step.kind]
    if (!kind?.handler) continue
    for (const slot of handlerInputSlots(kind.handler)) {
      for (const id of collectCatalogIdsFromValueSource(slot.source)) ids.add(id)
      const bound = step.bindings?.[slot.name.trim()]
      for (const id of collectCatalogIdsFromValueSource(bound)) ids.add(id)
    }
  }
  return [...ids].sort()
}

/** @deprecated Use collectCatalogIdsFromFlowSteps */
export const collectBindingSourceIdsFromFlowSteps = collectCatalogIdsFromFlowSteps

/** @deprecated Use stepFieldKeysForStep */
export const stepFieldIdsForStep = stepFieldKeysForStep

/** @deprecated Use stepFieldKeysFromHandler */
export const stepFieldIdsFromHandler = stepFieldKeysFromHandler
