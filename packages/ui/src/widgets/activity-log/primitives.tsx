import { Check, Circle, Loader2, Minus } from "lucide-react"
import type { OperationStatus } from "../../api"
import { AL, statusColorClass, statusDotColor } from "./tokens"
import { statusLabel } from "../../lib/operation-presentation"

export function StatusIcon({
  status,
  size = 14,
  showLabel,
}: {
  status: OperationStatus
  size?: number
  showLabel?: boolean
}) {
  const colorClass = statusColorClass(status)
  const dotClass = statusDotColor(status)

  let icon = <Circle size={size - 2} className={colorClass} strokeWidth={2.5} fill="none" />

  if (status === "running") {
    icon = <Loader2 size={size} className={`${colorClass} animate-spin`} />
  } else if (status === "success") {
    icon = <Check size={size} className={colorClass} strokeWidth={2.5} />
  } else if (status === "failed") {
    icon = (
      <span
        className={`inline-flex h-[${size}px] w-[${size}px] items-center justify-center rounded-full ${dotClass}`}
        style={{ width: size, height: size }}
      >
        <span className="h-[6px] w-[6px] rounded-full bg-canvas" />
      </span>
    )
  } else if (status === "skipped" || status === "cancelled") {
    icon = <Minus size={size} className={colorClass} strokeWidth={2.5} />
  } else {
    icon = <span className={`inline-block rounded-full ${dotClass}`} style={{ width: 8, height: 8 }} />
  }

  if (!showLabel) {
    return <span className="flex w-4 shrink-0 items-center justify-center">{icon}</span>
  }

  return (
    <span className={`inline-flex items-center gap-1 shrink-0 text-[11px] font-medium ${colorClass}`}>
      {icon}
      {statusLabel(status)}
    </span>
  )
}

export function KindBadge({ abbrev, color }: { abbrev: string; color: string }) {
  return (
    <span
      className="shrink-0 rounded px-1 py-px font-mono text-[10px] font-medium uppercase tracking-wide text-text-muted"
      style={{ color }}
    >
      {abbrev}
    </span>
  )
}

export function RowMeta({ duration, time }: { duration?: string | null; time?: string | null }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-3">
      {duration ? <span className={AL.meta}>{duration}</span> : null}
      {time ? <span className={`${AL.meta} w-14 text-right`}>{time}</span> : null}
    </span>
  )
}
