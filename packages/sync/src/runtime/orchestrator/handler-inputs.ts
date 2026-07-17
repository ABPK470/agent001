/**
 * Resolve handler input slots via ValueSource.
 */

import type { SyncHandlerInput } from "@mia/shared-types"
import { isLiteralValueSource, resolveSlotValueSource } from "@mia/shared-types"

import type { SyncExecutionContractStep } from "../plan-store.js"
import type { FlowStepRunContext } from "./flow-step-executor.js"
import { resolveValueSource } from "./value-source-resolver.js"

export async function resolveHandlerInputs(
  slots: readonly SyncHandlerInput[] | undefined,
  ctx: FlowStepRunContext,
  step: SyncExecutionContractStep,
): Promise<Record<string, unknown>> {
  const values: Record<string, unknown> = {}
  for (const slot of slots ?? []) {
    const name = slot.name.trim()
    if (!name) continue
    if (isLiteralValueSource(slot.source)) {
      values[name] = slot.source.value
      continue
    }
    const source = slot.source ?? resolveSlotValueSource(slot, step)
    values[name] = await resolveValueSource(source, ctx, step)
  }
  return values
}
