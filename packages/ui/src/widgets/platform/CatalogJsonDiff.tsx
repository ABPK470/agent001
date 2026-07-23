/**
 * Unified line diff for catalog JSON payloads.
 * Default shows the full document; `changesOnly` collapses unchanged runs
 * with click-to-expand ellipses (works above and below change hunks).
 *
 * Large one-sided diffs (create / delete) are paginated so the Publish modal
 * stays responsive.
 */

import type { JSX } from "react"
import { useEffect, useMemo, useState } from "react"
import {
  buildLineTextDiff,
  collapseUnchangedDiffRows,
  materializeCollapsedDiffRows,
  type LineDiffRow,
} from "../../lib/line-text-diff"

/** Soft cap before "Show more" — keeps expand clicks from freezing the modal. */
const INITIAL_VISIBLE_ROWS = 120
const VISIBLE_STEP = 200

export function CatalogJsonDiff({
  beforeJson,
  afterJson,
  changesOnly = false,
  className,
}: {
  beforeJson: string | null
  afterJson: string | null
  /** Show change hunks + short context — not the entire unchanged JSON. */
  changesOnly?: boolean
  className?: string
}): JSX.Element {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [visibleLimit, setVisibleLimit] = useState(INITIAL_VISIBLE_ROWS)

  const collapsed = useMemo(() => {
    const full = buildLineTextDiff(beforeJson ?? "", afterJson ?? "")
    return changesOnly ? collapseUnchangedDiffRows(full, 2) : full
  }, [beforeJson, afterJson, changesOnly])

  useEffect(() => {
    setExpandedIds(new Set())
    setVisibleLimit(INITIAL_VISIBLE_ROWS)
  }, [beforeJson, afterJson, changesOnly])

  const rows = useMemo(
    () => (changesOnly ? materializeCollapsedDiffRows(collapsed, expandedIds) : collapsed),
    [changesOnly, collapsed, expandedIds],
  )

  const visibleRows = rows.slice(0, visibleLimit)
  const hiddenCount = Math.max(0, rows.length - visibleLimit)

  function onToggleEllipsis(id: string): void {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (rows.length === 0) {
    return <p className="px-3 py-2 text-xs text-text-muted">Empty JSON.</p>
  }

  return (
    <div className="space-y-2">
      <pre
        className={[
          "overflow-auto show-scrollbar rounded-md border border-border-subtle bg-base/50 font-mono text-[11px] leading-relaxed",
          className ?? "max-h-80",
        ].join(" ")}
      >
        <code className="block min-w-full">
          {visibleRows.map((row, index) => (
            <DiffLine
              key={`${row.kind}-${row.id ?? `${row.oldLine}-${row.newLine}`}-${index}`}
              row={row}
              onToggleEllipsis={onToggleEllipsis}
            />
          ))}
        </code>
      </pre>
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setVisibleLimit((n) => n + VISIBLE_STEP)}
          className="w-full rounded-md border border-border-subtle px-2.5 py-1.5 text-xs text-text-muted transition-colors hover:bg-elevated/50 hover:text-text"
        >
          Show more ({hiddenCount} line{hiddenCount === 1 ? "" : "s"} remaining)
        </button>
      )}
    </div>
  )
}

function DiffLine({
  row,
  onToggleEllipsis,
}: {
  row: LineDiffRow
  onToggleEllipsis: (id: string) => void
}): JSX.Element {
  if (row.kind === "ellipsis") {
    const id = row.id
    const expandable = Boolean(id && row.hiddenRows?.length)
    if (!expandable) {
      return (
        <div className="px-2 py-1 text-center text-text-faint select-none">
          {row.text}
        </div>
      )
    }
    return (
      <button
        type="button"
        onClick={() => onToggleEllipsis(id!)}
        className="flex w-full items-center justify-center gap-1.5 px-2 py-1.5 text-center text-text-muted transition-colors hover:bg-elevated/50 hover:text-accent"
        title={row.text}
      >
        <span aria-hidden className="text-text-faint">···</span>
        <span className="underline decoration-dotted underline-offset-2">{row.text}</span>
        <span aria-hidden className="text-text-faint">···</span>
      </button>
    )
  }
  const tone =
    row.kind === "added"
      ? "bg-success-soft text-success"
      : row.kind === "removed"
        ? "bg-error-soft text-error"
        : "text-text"
  const marker = row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " "
  return (
    <div className={`grid grid-cols-[2.5rem_2.5rem_1.25rem_minmax(0,1fr)] gap-1 px-2 py-0.5 ${tone}`}>
      <span className="select-none text-right text-text-faint tabular-nums">
        {row.oldLine ?? ""}
      </span>
      <span className="select-none text-right text-text-faint tabular-nums">
        {row.newLine ?? ""}
      </span>
      <span className="select-none text-center opacity-80">{marker}</span>
      <span className="min-w-0 whitespace-pre-wrap break-all">{row.text.length === 0 ? " " : row.text}</span>
    </div>
  )
}
