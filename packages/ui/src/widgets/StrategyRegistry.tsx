/**
 * StrategyRegistry — wrapper that opens the Sync Operations Console
 * pre-focused on the SCD2 strategies section.
 *
 * Existing layouts referencing the `"scd2-strategies"` widget id
 * continue to render exactly the strategy management UI they used
 * to, but inside the unified console chrome so users get the full
 * left-rail navigation too.
 */

import type { JSX } from "react"
import { SyncAdminShell } from "./sync-admin/SyncAdminShell"

export function StrategyRegistry(): JSX.Element {
  return <SyncAdminShell initial="strategies" />
}
