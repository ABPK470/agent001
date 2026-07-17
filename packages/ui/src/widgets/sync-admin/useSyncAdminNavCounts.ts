import { useCallback, useEffect, useState } from "react"

import { api } from "../../client/index"
import { useLiveReload } from "./useLiveReload"

export interface SyncAdminNavCounts {
  proposals: number
  approvals: number
}

const EMPTY: SyncAdminNavCounts = { proposals: 0, approvals: 0 }

export function useSyncAdminNavCounts(): SyncAdminNavCounts {
  const [counts, setCounts] = useState<SyncAdminNavCounts>(EMPTY)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [proposals, pending, partial] = await Promise.all([
        api.listProposals({ status: "open,awaiting_approval,previewed,snoozed" }),
        api.listApprovals({ state: "pending" }),
        api.listApprovals({ state: "partially_granted" }),
      ])
      setCounts({
        proposals: (proposals as unknown[]).length,
        approvals: (pending as unknown[]).length + (partial as unknown[]).length,
      })
    } catch {
      setCounts(EMPTY)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  useLiveReload(
    refresh,
    (type) =>
      type.startsWith("sync.proposal")
      || type.startsWith("sync.approval")
      || type.startsWith("sync.proposer"),
  )

  return counts
}
