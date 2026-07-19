/**
 * Unified line diff for catalog JSON payloads.
 * Default shows the full document; `changesOnly` collapses unchanged runs.
 */

import type { JSX } from "react"
import { useMemo } from "react"
import {
  buildLineTextDiff,
  collapseUnchangedDiffRows,
  type LineDiffRow,
} from "../../lib/line-text-diff"

export function CatalogJsonDiff({
  beforeJson,
  afterJson,
  changesOnly = false,
}: {
  beforeJson: string | null
  afterJson: string | null
  /** Show change hunks + short context — not the entire unchanged JSON. */
  changesOnly?: boolean
}): JSX.Element {
  const rows = useMemo(() => {
    const full = buildLineTextDiff(beforeJson ?? "", afterJson ?? "")
    return changesOnly ? collapseUnchangedDiffRows(full, 2) : full
  }, [beforeJson, afterJson, changesOnly])

  if (rows.length === 0) {
    return <p className="px-3 py-2 text-xs text-text-muted">Empty JSON.</p>
  }

  return (
    <pre className="max-h-80 overflow-auto show-scrollbar rounded-md border border-border-subtle bg-base/50 font-mono text-[11px] leading-relaxed">
      <code className="block min-w-full">
        {rows.map((row, index) => (
          <DiffLine key={`${row.kind}-${row.oldLine ?? "x"}-${row.newLine ?? "y"}-${index}`} row={row} />
        ))}
      </code>
    </pre>
  )
}

function DiffLine({ row }: { row: LineDiffRow }): JSX.Element {
  if (row.kind === "ellipsis") {
    return (
      <div className="px-2 py-1 text-center text-text-faint select-none">
        {row.text}
      </div>
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
