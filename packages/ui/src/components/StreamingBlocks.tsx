import { isDiagramLang, tryInferDiagramKind } from "./InlineDiagram"

/**
 * Quiet pending shell for incomplete structured answer blocks
 * (pipe-tables and ``` chart / KPI / dashboard fences).
 *
 * No shimmering labels — just a soft skeleton placeholder until the whole
 * block is ready, then SmartAnswer paints it in one shot. Tables and charts
 * share the same chrome family so the reserved stage feels identical.
 */

/** Chart / dashboard footprint — tables aim at the same visual stage. */
export const STRUCTURED_PENDING_CHART_HEIGHT = 264
export const STRUCTURED_PENDING_DASHBOARD_HEIGHT = 288
export const STRUCTURED_PENDING_KPI_HEIGHT = 120

/**
 * Estimate reserved height for an in-flight pipe-table from its remainder.
 * Floors near a real CompactTable so settle does not jump from a stub shell.
 */
export function estimateTablePendingHeight(remainder: string): number {
  const pipeLines = remainder
    .split("\n")
    .filter((line) => line.trimStart().startsWith("|"))
  // header + separator + rows → visual band roughly header + data rows
  const visualRows = Math.max(pipeLines.length, 4)
  const raw = 52 + visualRows * 36
  return Math.min(STRUCTURED_PENDING_CHART_HEIGHT, Math.max(168, raw))
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
  return (
    <div
      className="stream-pending-shell rounded-lg border border-border-subtle px-3 py-2.5 flex flex-col my-1.5"
      style={{ minHeight }}
      role="status"
      aria-label={pendingAriaLabel(lang)}
    >
      <div className="stream-pending-shell__skeleton flex-1" aria-hidden="true" />
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
