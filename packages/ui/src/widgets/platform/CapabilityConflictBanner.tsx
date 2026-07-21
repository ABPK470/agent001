/**
 * Surfaces governance-vs-connector-write conflicts with the same chrome
 * as other platform warning banners (SelectorRulesTab / PlatformHealth).
 */

import { AlertCircle } from "lucide-react"
import type { JSX } from "react"
import type { ConnectorWriteConflict } from "@mia/shared-types"

export function CapabilityConflictBanner({
  conflict,
  className = "",
}: {
  conflict: ConnectorWriteConflict
  className?: string
}): JSX.Element {
  return (
    <div
      className={`flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3.5 py-2.5 text-sm text-text ${className}`}
      role="status"
    >
      <AlertCircle size={15} className="mt-0.5 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 space-y-1">
        <div className="font-semibold text-warning">{conflict.summary}</div>
        <p className="text-text-muted leading-relaxed">{conflict.detail}</p>
      </div>
    </div>
  )
}
