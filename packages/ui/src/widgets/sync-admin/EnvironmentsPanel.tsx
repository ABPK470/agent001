/**
 * @deprecated Sync targets live in Configuration → Targets. Kept as a thin re-export.
 */

import type { JSX } from "react"
import { ConsoleProvider } from "./console-context"

/** @deprecated Use Configuration modal → Targets tab */
export function EnvironmentsPanel(): JSX.Element {
  return (
    <ConsoleProvider>
      <p className="p-4 text-sm text-text-muted">
        Sync targets are managed under Entity Registry → Configuration → Targets.
      </p>
    </ConsoleProvider>
  )
}

export { useSyncTargets } from "../entity-registry/sync-targets/useSyncTargets"
