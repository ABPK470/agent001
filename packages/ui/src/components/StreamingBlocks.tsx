import { isDiagramLang, tryInferDiagramKind } from "./InlineDiagram"

/**
 * Quiet pending shell for incomplete structured answer blocks
 * (pipe-tables and ``` chart / KPI / dashboard fences).
 *
 * No shimmering labels — just a soft skeleton placeholder until the whole
 * block is ready, then SmartAnswer paints it in one shot.
 */

function pendingShellMinHeight(lang: string): number {
  const lower = lang.toLowerCase().trim()
  if (lower === "table") return 120
  if (lower === "kpi" || lower === "kpis" || lower === "metric" || lower === "metrics") {
    return 120
  }
  if (lower === "dashboard") return 288
  if (
    isDiagramLang(lower)
    || lower === ""
    || lower === "json"
    || lower === "json5"
    || lower === "chart"
  ) {
    return 264
  }
  return 120
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
export function StructuredPendingBlock({ lang }: { lang: string }) {
  const minHeight = pendingShellMinHeight(lang)
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
