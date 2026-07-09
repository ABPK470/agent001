import type { JSX } from "react"
import { SyncAdminShell } from "./sync-admin/SyncAdminShell"

/** @deprecated Use Sync Admin widget — opens Runs → Evidence tab. */
export function SyncEvidence(): JSX.Element {
  return <SyncAdminShell initial="runs" runsTab="evidence" />
}
