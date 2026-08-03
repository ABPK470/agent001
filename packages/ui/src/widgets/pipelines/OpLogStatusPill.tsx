/**
 * Pipelines status column — same micro pills as Trace master-detail tree.
 */

import { Loader2 } from "lucide-react"
import type { OperationStatus } from "../../client/index"
import { operationStatusPill, statusCalloutTone } from "../../lib/status-callout"

const PILL_META: Record<
  ReturnType<typeof statusCalloutTone>,
  { label: string; icon: string }
> = {
  ok: { label: "OK", icon: "✓" },
  err: { label: "Fail", icon: "✕" },
  warn: { label: "Warn", icon: "!" },
  info: { label: "Run", icon: "…" },
  skip: { label: "Skip", icon: "⊝" },
  muted: { label: "?", icon: "?" },
}

const TONE_FOR_PILL: Record<ReturnType<typeof statusCalloutTone>, string> = {
  ok: "success",
  err: "failed",
  warn: "warning",
  info: "running",
  skip: "skipped",
  muted: "unknown",
}

export function OpLogStatusPill({ status }: { status: OperationStatus }) {
  const tone = statusCalloutTone(status)
  const meta = PILL_META[tone]
  const pillTone = TONE_FOR_PILL[tone]

  return (
    <span
      className={`${operationStatusPill(pillTone)} trace-tree-status-pill op-log-status-pill`}
      title={meta.label}
    >
      {status === "running" ? (
        <Loader2 size={10} className="animate-spin op-log-status-pill__spin" aria-hidden />
      ) : (
        <span className="trace-tree-status-pill__icon" aria-hidden>
          {meta.icon}
        </span>
      )}
      <span className="trace-tree-status-pill__label">{meta.label}</span>
    </span>
  )
}
