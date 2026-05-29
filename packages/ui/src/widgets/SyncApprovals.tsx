import type { JSX } from "react"
import { SyncAdminShell } from "./sync-admin/SyncAdminShell"

export function SyncApprovals(): JSX.Element {
  return <SyncAdminShell initial="approvals" />
}
