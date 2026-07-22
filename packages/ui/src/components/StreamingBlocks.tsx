import { isDiagramLang, tryInferDiagramKind } from "./InlineDiagram"

/** Min heights so closing a fence does not cliff the scrollport. */
function pendingShellMinHeight(lang: string): number | undefined {
  const lower = lang.toLowerCase()
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
  if (lower === "table") return 120
  return undefined
}

function PendingShell({ label, minHeight }: { label: string; minHeight?: number }) {
  return (
    <div
      className="stream-pending-shell rounded-lg border border-border-subtle px-3 py-2.5 flex flex-col justify-center gap-2 my-1.5"
      style={minHeight ? { minHeight } : undefined}
    >
      <div className="flex items-center gap-2.5">
        <span className="w-1.5 h-1.5 rounded-full bg-accent/70 animate-pulse shrink-0" />
        <span className="text-[13px] text-text-muted font-mono">{label}</span>
      </div>
      {minHeight ? (
        <div className="stream-pending-shell__skeleton" aria-hidden="true" />
      ) : null}
    </div>
  )
}

export function StructuredPendingBlock({ lang }: { lang: string }) {
  const lower = lang.toLowerCase()
  const label = isDiagramLang(lower)
    ? `${lower} chart rendering…`
    : lower && lower !== "text" && lower !== "json" && lower !== "json5"
      ? `${lower} rendering…`
      : "chart rendering…"
  return <PendingShell label={label} minHeight={pendingShellMinHeight(lower)} />
}

/** Quiet placeholder until the full pipe-table arrives — never grow row-by-row. */
export function TablePendingBlock() {
  return <PendingShell label="table rendering…" minHeight={pendingShellMinHeight("table")} />
}

/** Infer diagram kind from partial JSON inside an open fence (best-effort). */
export function inferPendingDiagramLabel(lang: string, partialSource: string): string {
  const lower = lang.toLowerCase()
  if (isDiagramLang(lower)) return `${lower} chart`
  if (lower === "" || lower === "json" || lower === "json5") {
    const inferred = tryInferDiagramKind(partialSource)
    if (inferred) return `${inferred} chart`
  }
  return lower && lower !== "text" ? `${lower} block` : "chart"
}
