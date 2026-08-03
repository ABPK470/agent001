/**
 * Sync diff movement counts — ins / upd / del / eq with consistent contrast.
 * Banner and table rows share this component so eq stays readable in light mode.
 */

import { DIFF } from "./constants"

export type SyncMovementCountsProps = {
  insert?: number
  update?: number
  delete?: number
  unchanged?: number
  conflicts?: number
  /** Banner totals use larger numbers; table rows stay compact. */
  variant?: "sm" | "md"
  className?: string
}

export function SyncMovementCounts({
  insert = 0,
  update = 0,
  delete: del = 0,
  unchanged = 0,
  conflicts = 0,
  variant = "sm",
  className = "",
}: SyncMovementCountsProps) {
  const numClass = variant === "md" ? "text-lg font-semibold" : ""
  const labelClass = variant === "md" ? "text-xs" : ""

  return (
    <span
      className={[
        "inline-flex flex-wrap items-center font-mono tabular-nums",
        variant === "md" ? "gap-3" : "gap-2",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {insert > 0 && (
        <Stat n={insert} label="ins" color={DIFF.ins} numClass={numClass} labelClass={labelClass} />
      )}
      {update > 0 && (
        <Stat n={update} label="upd" color={DIFF.upd} numClass={numClass} labelClass={labelClass} />
      )}
      {del > 0 && (
        <Stat n={del} label="del" color={DIFF.del} numClass={numClass} labelClass={labelClass} />
      )}
      {conflicts > 0 && (
        <span className={numClass ? `${numClass} text-warning` : "text-sm text-warning"}>
          {conflicts.toLocaleString()} <span className={labelClass}>cnf</span>
        </span>
      )}
      {unchanged > 0 && (
        <Stat n={unchanged} label="eq" color={DIFF.eq} numClass={numClass} labelClass={labelClass} />
      )}
    </span>
  )
}

function Stat({
  n,
  label,
  color,
  numClass,
  labelClass,
}: {
  n: number
  label: string
  color: string
  numClass: string
  labelClass: string
}) {
  return (
    <span className="text-sm shrink-0" style={{ color }}>
      <span className={numClass}>{n.toLocaleString()}</span>
      {labelClass ? (
        <>
          {" "}
          <span className={labelClass}>{label}</span>
        </>
      ) : (
        <> {label}</>
      )}
    </span>
  )
}
