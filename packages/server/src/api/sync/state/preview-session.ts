/**
 * Registers in-flight sync previews in the cancel registry so HTTP cancel
 * routes share one AbortSignal per planId (same dialect as execute).
 */

import type { AgentHost } from "@mia/agent"
import { allocPlanId, previewSync, type PreviewInput } from "@mia/sync"
import {
  registerOperation,
  unregisterOperation,
} from "../../../infra/operations/cancel-registry.js"

export const SYNC_PREVIEW_OPERATION = "sync.preview" as const

export type RunRegisteredSyncPreviewInput = Omit<PreviewInput, "host" | "planId" | "signal"> & {
  host: AgentHost
}

export async function runRegisteredSyncPreview(input: RunRegisteredSyncPreviewInput) {
  const planId = allocPlanId()
  const signal = registerOperation(
    SYNC_PREVIEW_OPERATION,
    planId,
    `Sync preview ${planId.slice(0, 8)}`,
  )
  try {
    return await previewSync({
      ...input,
      host: input.host,
      planId,
      signal,
    })
  } finally {
    unregisterOperation(SYNC_PREVIEW_OPERATION, planId)
  }
}
