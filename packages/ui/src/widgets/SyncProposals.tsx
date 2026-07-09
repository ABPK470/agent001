import type { JSX } from "react"
import { SyncAdminShell } from "./sync-admin/SyncAdminShell"

/** @deprecated Use Sync Admin widget — opens the Proposals panel. */
export function SyncProposals(): JSX.Element {
  return <SyncAdminShell initial="proposals" />
}
