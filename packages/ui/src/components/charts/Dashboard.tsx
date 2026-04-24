/**
 * Dashboard — lays out multiple charts/tables/text blocks in a 12-column
 * responsive grid. Each item picks a width 1..12 and any supported chart kind.
 */

import type React from "react"
import { renderChart, type ChartKind } from "./index"

export interface DashboardItem {
  kind: ChartKind | "text"
  width?: number          // 1..12 (defaults to 12)
  spec: unknown
}

export interface DashboardData {
  title?: string
  subtitle?: string
  items: DashboardItem[]
}

export function Dashboard({ data }: { data: DashboardData }): React.ReactElement {
  const items = data.items ?? []
  return (
    <div className="rounded-lg overflow-hidden border border-white/[0.10] bg-base">
      {(data.title || data.subtitle) && (
        <div className="px-3 py-2 border-b border-white/[0.08] flex items-baseline gap-2 flex-wrap bg-white/[0.03]">
          {data.title && <div className="text-sm font-bold text-text">{data.title}</div>}
          {data.subtitle && <div className="text-[11px] text-text-muted">{data.subtitle}</div>}
          <div className="ml-auto text-[10px] text-text-muted font-mono uppercase tracking-wide">dashboard</div>
        </div>
      )}
      <div className="p-2 grid gap-2" style={{ gridTemplateColumns: "repeat(12, minmax(0, 1fr))" }}>
        {items.map((item, i) => {
          const w = Math.max(1, Math.min(12, item.width ?? 12))
          return (
            <div key={i} className="min-w-0" style={{ gridColumn: `span ${w} / span ${w}` }}>
              {item.kind === "text"
                ? <TextPanel spec={item.spec} />
                : renderChart(item.kind, item.spec)}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TextPanel({ spec }: { spec: unknown }): React.ReactElement {
  const text = typeof spec === "string" ? spec
    : typeof (spec as { text?: string })?.text === "string" ? (spec as { text: string }).text
    : ""
  const title = (spec as { title?: string })?.title
  return (
    <div className="rounded-lg border border-white/[0.08] bg-base p-3 text-sm text-text-secondary leading-relaxed">
      {title && <div className="text-sm font-semibold text-text mb-1">{title}</div>}
      <div className="whitespace-pre-wrap">{text}</div>
    </div>
  )
}
