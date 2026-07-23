import { AlertCircle, X } from "lucide-react"
import { useEffect, useState } from "react"

import type { PlatformHealth } from "../../client/index"
import { SetupHintStrip } from "../../components/SetupHintStrip"

const DISMISS_KEY = "mia:platform-health-dismissed"

export function PlatformHealthBanner({
  health,
  isAdmin,
  onRefresh,
}: {
  health: PlatformHealth | null
  isAdmin: boolean
  onRefresh?: () => void
}) {
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    try {
      const stored = window.sessionStorage.getItem(DISMISS_KEY)
      setDismissed(stored === "1")
    } catch {
      setDismissed(false)
    }
  }, [])

  if (!isAdmin || !health || health.ready || dismissed || health.hints.length === 0) {
    return null
  }

  const dismiss = () => {
    setDismissed(true)
    try {
      window.sessionStorage.setItem(DISMISS_KEY, "1")
    } catch (err: unknown) { console.error("[mia]", err) }
  }

  return (
    <SetupHintStrip
      className="px-4 sm:px-6"
      actions={
        <>
          {onRefresh && (
            <button
              type="button"
              className="text-[12px] text-text-muted underline-offset-2 hover:text-text hover:underline"
              onClick={() => onRefresh()}
            >
              Refresh
            </button>
          )}
          <button
            type="button"
            onClick={dismiss}
            className="rounded p-1 text-text-muted hover:bg-overlay-2 hover:text-text"
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </>
      }
    >
      <div className="mx-auto flex max-w-[1400px] items-start gap-3">
        <AlertCircle size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium text-text">Platform setup incomplete</p>
          <ul className="list-disc space-y-0.5 pl-4 text-[13px] leading-relaxed text-text-muted">
            {health.hints.map((hint) => (
              <li key={hint}>{hint}</li>
            ))}
          </ul>
          <p className="pt-0.5 text-[12px] text-text-muted/80">
            MSSQL: {health.mssql.configured ? health.mssql.summary : "not configured"} · Entities:{" "}
            {health.entities.count}
            {health.publish.definitionCount > 0
              ? ` · Published: ${health.publish.definitionCount}`
              : " · Not published"}
          </p>
        </div>
      </div>
    </SetupHintStrip>
  )
}
