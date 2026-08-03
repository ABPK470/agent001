/**
 * Pipelines status badge — 20×20 tinted circle + micro icon.
 * Readable in light theme; no naked dots or inline text pills.
 */

import { Check, Loader2, Minus, X } from "lucide-react"
import type { OperationStatus } from "../../client/index"
import { statusCalloutTone, type StatusCalloutTone } from "../../lib/status-callout"

const STATUS_LABEL: Record<StatusCalloutTone, string> = {
  ok: "Success",
  err: "Failed",
  warn: "Warning",
  info: "Running",
  skip: "Skipped",
  muted: "Unknown",
}

function useSubtleBadge(status: OperationStatus, nested: boolean): boolean {
  if (!nested) return false
  const tone = statusCalloutTone(status)
  return tone === "ok" || tone === "muted" || tone === "skip"
}

function StatusGlyph({ status, subtle }: { status: OperationStatus; subtle: boolean }) {
  const tone = statusCalloutTone(status)
  if (subtle) return null
  if (tone === "info" || status === "running") {
    return <Loader2 size={11} strokeWidth={2.25} className="op-log-status-badge__spin" />
  }
  if (tone === "err") {
    return <X size={11} strokeWidth={2.5} />
  }
  if (tone === "ok") {
    return <Check size={11} strokeWidth={2.5} />
  }
  if (tone === "skip") {
    return <Minus size={11} strokeWidth={2.5} />
  }
  return <span className="op-log-status-badge__dot" aria-hidden />
}

export function OpLogStatusBadge({
  status,
  nested = false,
}: {
  status: OperationStatus
  /** Nested peer rows use a quieter hollow badge for terminal ok/skip. */
  nested?: boolean
}) {
  const tone = statusCalloutTone(status)
  const subtle = useSubtleBadge(status, nested)
  const label = STATUS_LABEL[tone]

  return (
    <span
      className={[
        "op-log-status-badge",
        subtle ? "op-log-status-badge--subtle" : `op-log-status-badge--${tone}`,
      ].join(" ")}
      title={label}
      aria-label={label}
    >
      <StatusGlyph status={status} subtle={subtle} />
    </span>
  )
}
