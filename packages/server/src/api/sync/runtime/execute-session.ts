/**
 * Registers in-flight sync executes in the cancel registry so HTTP cancel
 * routes and SSE client disconnects share one AbortSignal per planId.
 */

import type { AgentHost } from "@mia/agent"
import { executeSync, type ExecuteProgress } from "@mia/sync"
import {
  registerOperation,
  unregisterOperation,
} from "../../../platform/operations/cancel-registry.js"

export const SYNC_EXECUTE_OPERATION = "sync.execute" as const

export interface RunRegisteredSyncExecuteInput {
  host: AgentHost
  planId: string
  userUpn: string | null
  onProgress?: (event: ExecuteProgress) => void
  overrideFreezeWindow?: boolean
}

export async function runRegisteredSyncExecute(input: RunRegisteredSyncExecuteInput) {
  const signal = registerOperation(
    SYNC_EXECUTE_OPERATION,
    input.planId,
    `Sync execute ${input.planId.slice(0, 8)}`,
  )
  try {
    return await executeSync(input.planId, {
      host: input.host,
      confirm: true,
      userUpn: input.userUpn,
      onProgress: input.onProgress,
      overrideFreezeWindow: input.overrideFreezeWindow,
      signal,
    })
  } finally {
    unregisterOperation(SYNC_EXECUTE_OPERATION, input.planId)
  }
}
