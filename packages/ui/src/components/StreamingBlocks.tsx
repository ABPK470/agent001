import { isDiagramLang, tryInferDiagramKind } from "./InlineDiagram"

/**
 * Same chrome as TermChat's live "Working" / tool milestone shimmer —
 * 15px, muted, activity-shimmer-tight. Used for incomplete tables and for
 * incomplete chart/KPI/dashboard fences — one visual language.
 */
function StreamPendingLabel({ label }: { label: string }) {
  return (
    <div className="py-1.5 pr-2">
      <span className="activity-shimmer-tight text-[15px] leading-6 font-normal inline-block text-text-muted">
        {label}
      </span>
    </div>
  )
}

/** Human label for an incomplete structured block (table / chart / KPI / …). */
export function pendingLabelForFenceLang(lang: string): string {
  const lower = lang.toLowerCase().trim()
  if (lower === "table") return "Table"
  if (lower === "kpi" || lower === "kpis" || lower === "metric" || lower === "metrics") {
    return "KPI"
  }
  if (lower === "dashboard") return "Dashboard"
  if (isDiagramLang(lower)) return "Chart"
  if (lower === "" || lower === "json" || lower === "json5" || lower === "chart") {
    return "Chart"
  }
  if (lower && lower !== "text") {
    return lower.charAt(0).toUpperCase() + lower.slice(1)
  }
  return "Chart"
}

/** Pending chrome for open fences and for pipe-tables (lang="table"). */
export function StructuredPendingBlock({ lang }: { lang: string }) {
  return <StreamPendingLabel label={pendingLabelForFenceLang(lang)} />
}

/** Infer diagram kind from partial JSON inside an open fence (best-effort). */
export function inferPendingDiagramLabel(lang: string, partialSource: string): string {
  const lower = lang.toLowerCase()
  if (isDiagramLang(lower)) return "Chart"
  if (lower === "" || lower === "json" || lower === "json5") {
    const inferred = tryInferDiagramKind(partialSource)
    if (inferred === "kpi" || inferred === "dashboard") {
      return pendingLabelForFenceLang(inferred)
    }
    if (inferred) return "Chart"
  }
  return pendingLabelForFenceLang(lower)
}
