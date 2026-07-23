/**
 * Flow scheduler — splits the ordered step list at metadataSync.
 *
 * Real execution regions (see execute.ts):
 *   1. before metadataSync — pre-transaction steps (audits, locks)
 *   2. metadataSync       — single SQL transaction on target
 *   3. after metadataSync — deploy / HTTP / pipeline steps
 *
 * Step order in the flow array is the authority. No separate "phase" catalog.
 */

import type { SyncExecutionContractStep } from "../../plan-store.js"
import { METADATA_SYNC_KIND_ID } from "@mia/shared-types"

export interface ScheduledFlow {
  beforeMetadata: SyncExecutionContractStep[]
  metadata: SyncExecutionContractStep
  afterMetadata: SyncExecutionContractStep[]
}

export function scheduleFlowSteps(steps: readonly SyncExecutionContractStep[]): ScheduledFlow {
  const metadataIndexes = steps
    .map((step, index) => (step.kind === METADATA_SYNC_KIND_ID ? index : -1))
    .filter((index) => index >= 0)

  if (metadataIndexes.length !== 1) {
    throw new Error(
      `Flow must include exactly one ${METADATA_SYNC_KIND_ID} step (found ${metadataIndexes.length}).`,
    )
  }

  const metadataIndex = metadataIndexes[0]!
  const metadata = steps[metadataIndex]!

  return {
    beforeMetadata: steps.slice(0, metadataIndex),
    metadata,
    afterMetadata: steps.slice(metadataIndex + 1),
  }
}
