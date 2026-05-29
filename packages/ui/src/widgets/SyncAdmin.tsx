/**
 * SyncAdmin — thin wrapper around the unified Sync Operations Console.
 *
 * The console (SyncAdminShell) hosts every sync-platform admin surface
 * — environments, schedules, approval policies, notification routes,
 * SCD2 strategies, freeze windows — behind a single left rail.
 *
 * This file exists only to keep the widget registry id `"sync-admin"`
 * stable for existing layouts.
 */

import type { JSX } from "react"
import { SyncAdminShell } from "./sync-admin/SyncAdminShell"

export function SyncAdmin(): JSX.Element {
  return <SyncAdminShell />
}
