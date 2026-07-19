import { isDiagramLang, tryInferDiagramKind } from "./InlineDiagram"
import { parsePartialTable } from "./answer-stream-layout"

/** Same wrapper as SmartAnswer CompactTable — keep live ↔ settled chrome identical. */
const TABLE_WRAPPER =
  "w-full min-w-0 overflow-x-auto rounded-md border border-border-subtle my-1.5"

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
  return undefined
}

export function StructuredPendingBlock({ lang }: { lang: string }) {
  const lower = lang.toLowerCase()
  const label = isDiagramLang(lower)
    ? `${lower} chart`
    : lower && lower !== "text" && lower !== "json" && lower !== "json5"
      ? `${lower} block`
      : "chart"
  const minHeight = pendingShellMinHeight(lower)

  return (
    <div
      className="stream-pending-shell rounded-lg border border-border-subtle px-3 py-2.5 flex flex-col justify-center gap-2 my-1.5"
      style={minHeight ? { minHeight } : undefined}
    >
      <div className="flex items-center gap-2.5">
        <span className="w-1.5 h-1.5 rounded-full bg-accent/70 animate-pulse shrink-0" />
        <span className="text-[13px] text-text-muted font-mono">{label} rendering…</span>
      </div>
      {minHeight ? (
        <div className="stream-pending-shell__skeleton" aria-hidden="true" />
      ) : null}
    </div>
  )
}

/**
 * Growing markdown pipe-table during SSE — same metrics/chrome as CompactTable
 * so completing a table never swaps layout (ring↔border, font-size, etc.).
 */
export function TablePendingBlock({ raw }: { raw: string }) {
  const parsed = parsePartialTable(raw)
  if (!parsed || parsed.headers.length === 0) {
    return (
      <div className={`${TABLE_WRAPPER} px-3 py-2.5 flex items-center gap-2.5`}>
        <span className="w-1.5 h-1.5 rounded-full bg-accent/70 animate-pulse shrink-0" />
        <span className="text-[15px] text-text-muted">Table rendering…</span>
      </div>
    )
  }

  return (
    <div className="py-2 space-y-1">
      <div className={TABLE_WRAPPER}>
        <table className="w-auto min-w-full text-[15px] leading-6 border-collapse">
          <thead>
            <tr>
              {parsed.headers.map((h, hi) => (
                <th
                  key={hi}
                  className={[
                    "text-left font-bold text-text-secondary text-[15px] px-3 py-1.5 border-b border-border-subtle whitespace-nowrap",
                    hi < parsed.headers.length - 1 ? "border-r border-border-subtle" : "",
                  ].join(" ")}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {parsed.rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    className={[
                      "px-3 py-1.5 align-top text-text-secondary",
                      ci < row.length - 1 ? "border-r border-border-subtle" : "",
                    ].join(" ")}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 px-1">
        <span className="w-1.5 h-1.5 rounded-full bg-accent/60 animate-pulse shrink-0" />
        <span className="text-[15px] text-text-muted">Loading rows…</span>
      </div>
    </div>
  )
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
