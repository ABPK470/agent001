/**
 * Handler input slots — literal, kind-fixed value source, or step-bound (via step.bindings).
 */

import type { AuthoredSyncFlowStep, SyncFlowKindHandler } from "./index.js"
import { collectCatalogIdsFromFlowSteps } from "./flow-step-bindings.js"
import type { ValueSource } from "./value-source.js"
import { collectCatalogIdsFromValueSource } from "./value-source.js"

export interface SyncHandlerInput {
  name: string
  /** When absent, resolved from step.bindings[name] (step-bound slot). */
  source?: ValueSource
}

/** @deprecated Use SyncHandlerInput */
export type SyncProcedureParameter = SyncHandlerInput

export const DEFAULT_CUSTOM_HANDLER_INPUTS: readonly SyncHandlerInput[] = [
  { name: "entityId", source: { type: "planEntityId" } },
  { name: "id", source: { type: "planEntityId" } },
  { name: "stepId", source: { type: "currentStepId" } },
]

export const DEFAULT_PROCEDURE_INPUTS: readonly SyncHandlerInput[] = [
  { name: "id", source: { type: "planEntityId" } },
]

/** Input slots for a handler after applying type-specific defaults. */
export function handlerInputSlots(handler: SyncFlowKindHandler): SyncHandlerInput[] {
  switch (handler.type) {
    case "mssql_procedure":
      if (handler.parameters !== undefined) return [...handler.parameters]
      return [...DEFAULT_PROCEDURE_INPUTS]
    case "http_request":
      return handler.httpBody?.length ? [...handler.httpBody] : []
    case "custom_sql":
    case "custom_shell_script":
      return handler.inputs?.length ? [...handler.inputs] : [...DEFAULT_CUSTOM_HANDLER_INPUTS]
    default:
      return []
  }
}

export function formatHandlerInputLiteral(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "boolean") return value ? "1" : "0"
  if (typeof value === "number") return String(value)
  return String(value)
}

/** Replace @slotName tokens using resolved input values (SQL batches, shell commands). */
export function substituteInputTokens(template: string, values: Record<string, unknown>): string {
  return template.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (full, name: string) => {
    if (!(name in values)) {
      throw new Error(
        `Template uses @${name} but this handler has no input slot named "${name}". Add an input or fix the template.`,
      )
    }
    return formatHandlerInputLiteral(values[name])
  })
}

function collectCatalogIdsFromSlots(
  slots: readonly SyncHandlerInput[] | undefined,
  ids: Set<string>,
): void {
  for (const slot of slots ?? []) {
    for (const id of collectCatalogIdsFromValueSource(slot.source)) ids.add(id)
  }
}

/** Collect custom catalog ids referenced by kind handlers (kind-fixed slots only). */
export function collectCustomValueSourceIdsFromKindDefinitions(
  kinds: Record<
    string,
    {
      handler?: SyncFlowKindHandler
    }
  >,
): string[] {
  const ids = new Set<string>()
  for (const kind of Object.values(kinds)) {
    if (!kind.handler) continue
    collectCatalogIdsFromSlots(handlerInputSlots(kind.handler), ids)
  }
  return [...ids]
}

/** Collect custom catalog ids from kind handlers and flow step bindings. */
export function collectCustomValueSourceIdsFromSteps(
  kinds: Record<string, { handler?: SyncFlowKindHandler }>,
  steps: readonly Pick<AuthoredSyncFlowStep, "kind" | "bindings">[],
): string[] {
  const fromKinds = collectCustomValueSourceIdsFromKindDefinitions(kinds)
  const fromSteps = collectCatalogIdsFromFlowSteps(steps, kinds)
  return [...new Set([...fromKinds, ...fromSteps])].sort()
}

/** @deprecated Use collectCustomValueSourceIdsFromSteps */
export const collectBindingSourceIdsFromSteps = collectCustomValueSourceIdsFromSteps

/** @deprecated Use collectCustomValueSourceIdsFromKindDefinitions */
export const collectBindingSourceIdsFromKindDefinitions = collectCustomValueSourceIdsFromKindDefinitions
