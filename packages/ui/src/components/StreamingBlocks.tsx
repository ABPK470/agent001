import { isDiagramLang, tryInferDiagramKind } from "./InlineDiagram"
import { parsePartialTable } from "./answer-stream-layout"

export function StructuredPendingBlock({ lang }: { lang: string }) {
  const lower = lang.toLowerCase()
  const label = isDiagramLang(lower)
    ? `${lower} chart`
    : lower && lower !== "text" && lower !== "json" && lower !== "json5"
      ? `${lower} block`
      : "chart"

  return (
    <div className="rounded-lg border border-border-subtle px-3 py-2.5 flex items-center gap-2.5 my-1.5">
      <span className="w-1.5 h-1.5 rounded-full bg-accent/70 animate-pulse shrink-0" />
      <span className="text-[13px] text-text-muted font-mono">{label} rendering…</span>
    </div>
  )
}

export function TablePendingBlock({ raw }: { raw: string }) {
  const parsed = parsePartialTable(raw)
  if (!parsed || parsed.headers.length === 0) {
    return (
      <div className="rounded-lg border border-border-subtle px-3 py-2.5 flex items-center gap-2.5 my-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-accent/70 animate-pulse shrink-0" />
        <span className="text-[13px] text-text-muted">Table rendering…</span>
      </div>
    )
  }

  return (
    <div className="py-1.5 space-y-1.5">
      <div className="w-full min-w-0 overflow-x-auto rounded-md ring-1 ring-border-subtle my-1.5">
        <table className="w-auto min-w-full text-[12.5px] leading-6 border-collapse">
          <thead>
            <tr>
              {parsed.headers.map((h, hi) => (
                <th
                  key={hi}
                  className={[
                    "text-left font-bold text-text-secondary text-[14px] px-3 py-1.5 border-b border-border-subtle whitespace-nowrap",
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
        <span className="text-[12px] text-text-muted">Loading rows…</span>
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
