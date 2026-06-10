/**
 * Dashboard — lays out multiple charts/tables/text blocks in a 12-column
 * responsive grid. Each item picks a width 1..12 and any supported chart kind.
 */

import type React from "react"
import { InlineDiagram, isDiagramLang } from "../InlineDiagram"
import { renderChart, type ChartKind } from "./index"
import { normalizeDashboardData } from "./normalizeDashboard"

export interface DashboardItem {
  kind: ChartKind | "relationships" | "flow" | "text"
  width?: number          // 1..12 (defaults to 12)
  spec: unknown
}

export interface DashboardData {
  title?: string
  subtitle?: string
  items: DashboardItem[]
}

export function Dashboard({ data }: { data: DashboardData }): React.ReactElement {
  const normalized = normalizeDashboardData(data)
  const items = normalized.items ?? []
  const title = normalized.title ?? data.title
  const subtitle = normalized.subtitle ?? data.subtitle

  return (
    <div className="rounded-lg overflow-hidden border border-border">
      {(title || subtitle) && (
        <div className="px-3 py-2 border-b border-border-subtle flex items-baseline gap-2 flex-wrap">
          {title && <div className="text-sm font-bold text-text">{title}</div>}
          {subtitle && <div className="text-sm text-text-muted">{subtitle}</div>}
          <div className="ml-auto text-[10px] text-text-muted font-mono uppercase tracking-wide">dashboard</div>
        </div>
      )}
      <div className="p-2 flex flex-col gap-2">
        {items.map((item, i) => {
          const el = item.kind === "text"
            ? <TextPanel spec={item.spec} />
            : isDiagramLang(item.kind)
              ? <InlineDiagram kind={item.kind} source={JSON.stringify(item.spec)} />
              : renderChart(item.kind as ChartKind, item.spec)
          // Skip charts that have nothing to show (null return)
          if (el === null) return null
          return (
            <div key={i} className="min-w-0 w-full">
              {el}
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
    <div className="rounded-lg border border-border-subtle p-3 text-sm text-text-secondary leading-relaxed">
      {title && <div className="text-sm font-semibold text-text mb-1">{title}</div>}
      <div className="whitespace-pre-wrap">{text}</div>
    </div>
  )
}
