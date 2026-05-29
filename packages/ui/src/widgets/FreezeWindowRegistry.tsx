/**
 * FreezeWindowRegistry — wrapper that opens the Sync Operations
 * Console pre-focused on freeze windows.
 *
 * The `"freeze-windows"` widget id stays valid for existing layouts;
 * users land directly on the freeze-windows panel with the full
 * console rail available for context-switching.
 */

import type { JSX } from "react"
import { SyncAdminShell } from "./sync-admin/SyncAdminShell"

export function FreezeWindowRegistry(): JSX.Element {
  return <SyncAdminShell initial="freezes" />
}
