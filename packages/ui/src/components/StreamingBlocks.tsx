import type { JSX } from "react"
import { isDiagramLang, tryInferDiagramKind } from "./inlineDiagram"

/**
 * Quiet pending shell for incomplete structured answer blocks
 * (pipe-tables and ``` chart / KPI / dashboard fences).
 *
 * Charts keep a soft stage blob. Tables use a fixed-height grid skeleton so
 * the reserved stage reads as a spreadsheet, not a chart — same hold-until-
 * complete + settle behaviour, different chrome.
 */

/** Chart / dashboard footprint. */
export const STRUCTURED_PENDING_CHART_HEIGHT = 264
export const STRUCTURED_PENDING_DASHBOARD_HEIGHT = 288
export const STRUCTURED_PENDING_KPI_HEIGHT = 120
/** Table stage — same fixed-height contract as charts (no grow-per-row shake). */
export const STRUCTURED_PENDING_TABLE_HEIGHT = 200

/**
 * Reserved height for an in-flight pipe-table.
 * Fixed like charts — growing with each pipe line ratcheted stick-to-bottom
 * and shook the transcript. Settle is one controlled jump to CompactTable.
 */
export function estimateTablePendingHeight(_remainder: string): number {
  void _remainder
  return STRUCTURED_PENDING_TABLE_HEIGHT
}

export function pendingShellMinHeight(lang: string, remainder = ""): number {
  const lower = lang.toLowerCase().trim()
  if (lower === "table") return estimateTablePendingHeight(remainder)
  if (lower === "kpi" || lower === "kpis" || lower === "metric" || lower === "metrics") {
    return STRUCTURED_PENDING_KPI_HEIGHT
  }
  if (lower === "dashboard") return STRUCTURED_PENDING_DASHBOARD_HEIGHT
  if (
    isDiagramLang(lower)
    || lower === ""
    || lower === "json"
    || lower === "json5"
    || lower === "chart"
  ) {
    return STRUCTURED_PENDING_CHART_HEIGHT
  }
  return STRUCTURED_PENDING_KPI_HEIGHT
}

function pendingAriaLabel(lang: string): string {
  const lower = lang.toLowerCase().trim()
  if (lower === "table") return "Loading table"
  if (lower === "kpi" || lower === "kpis" || lower === "metric" || lower === "metrics") {
    return "Loading KPI"
  }
  if (lower === "dashboard") return "Loading dashboard"
  if (isDiagramLang(lower) || lower === "chart" || lower === "json" || lower === "json5" || !lower) {
    return "Loading chart"
  }
  return "Loading"
}

function TablePendingSkeleton(): JSX.Element {
  const rows = [0, 1, 2, 3, 4]
  const cols = [0, 1, 2, 3]
  return (
    <div className="stream-pending-table flex-1 flex flex-col min-h-0" aria-hidden="true">
      <div className="stream-pending-table__row stream-pending-table__row--head">
        {cols.map((c) => (
          <div key={c} className="stream-pending-table__cell" />
        ))}
      </div>
      {rows.map((r) => (
        <div key={r} className="stream-pending-table__row">
          {cols.map((c) => (
            <div key={c} className="stream-pending-table__cell" />
          ))}
        </div>
      ))}
    </div>
  )
}

/** Pending chrome for open fences and for pipe-tables (lang="table"). */
export function StructuredPendingBlock({
  lang,
  remainder = "",
}: {
  lang: string
  /** In-flight fence/table text — used to size the table stage. */
  remainder?: string
}) {
  const minHeight = pendingShellMinHeight(lang, remainder)
  const isTable = lang.toLowerCase().trim() === "table"
  return (
    <div
      className={[
        "stream-pending-shell rounded-lg border border-border-subtle flex flex-col my-1.5",
        isTable ? "px-2 py-1.5" : "px-3 py-2.5",
      ].join(" ")}
      style={{ minHeight }}
      role="status"
      aria-label={pendingAriaLabel(lang)}
    >
      {isTable ? (
        <TablePendingSkeleton />
      ) : (
        <div className="stream-pending-shell__skeleton flex-1" aria-hidden="true" />
      )}
    </div>
  )
}

/** Infer diagram kind from partial JSON inside an open fence (best-effort). */
export function inferPendingDiagramLabel(lang: string, partialSource: string): string {
  const lower = lang.toLowerCase()
  if (isDiagramLang(lower)) return "Chart"
  if (lower === "" || lower === "json" || lower === "json5") {
    const inferred = tryInferDiagramKind(partialSource)
    if (inferred === "kpi") return "KPI"
    if (inferred === "dashboard") return "Dashboard"
    if (inferred) return "Chart"
  }
  if (lower === "table") return "Table"
  if (lower === "kpi" || lower === "kpis") return "KPI"
  if (lower === "dashboard") return "Dashboard"
  return "Chart"
}
