/**
 * ChartFrame — shared chrome for all charts: outer card, title, subtitle,
 * legend strip. Individual chart components handle the SVG body.
 */

import type React from "react"
import { pickColor } from "./helpers"

export interface LegendEntry { name: string; color: string }

export function ChartFrame({
  title, subtitle, legend, children, badge,
}: {
  title?: string
  subtitle?: string
  legend?: LegendEntry[]
  badge?: string
  children: React.ReactNode
}): React.ReactElement {
  const showHeader = !!(title || subtitle || badge)
  const showLegend = legend && legend.length > 0
  return (
    <div className="rounded-lg overflow-hidden border border-border-subtle">
      {showHeader && (
        <div className="px-3 pt-2 pb-1.5 border-b border-border-subtle flex items-baseline gap-2 flex-wrap">
          {title && <div className="text-sm font-semibold text-text">{title}</div>}
          {subtitle && <div className="text-[11px] text-text-muted">{subtitle}</div>}
          {badge && (
            <div className="ml-auto text-[10px] text-text-muted font-mono tracking-wide uppercase">{badge}</div>
          )}
        </div>
      )}
      <div className="flex min-w-0 justify-center overflow-x-auto p-3">{children}</div>
      {showLegend && (
        <div className="px-3 pb-2 -mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          {legend!.map((entry, i) => (
            <div key={i} className="flex items-center gap-1.5 text-[11px] text-text-secondary">
              <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: entry.color }} />
              <span className="truncate max-w-[160px]">{entry.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function deriveLegend(seriesNames: string[]): LegendEntry[] {
  return seriesNames.map((name, i) => ({ name, color: pickColor(i) }))
}
