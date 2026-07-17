/**
 * @deprecated Sync environments live in Configuration → Environments. Kept as a thin re-export.
 */

import type { JSX } from "react"
import { ConsoleProvider } from "./console-context"

/** @deprecated Use Configuration modal → Environments tab */
export function EnvironmentsPanel(): JSX.Element {
  return (
    <ConsoleProvider>
      <p className="p-4 text-sm text-text-muted">
        Sync environments are managed under Entity Registry → Configuration → Environments.
      </p>
    </ConsoleProvider>
  )
}

export { useSyncEnvironments } from "../entity-registry/sync-environments/useSyncEnvironments"
