/**
 * LineChart — multi-series line / area chart with optional smoothing,
 * point markers, and value-axis ticks.
 */

import type React from "react";
import { ChartFrame, deriveLegend } from "./ChartFrame";
import { formatTick, formatValue, niceDomain, niceTicks, pickColor, type ValueFormat } from "./helpers";

export interface LineSeries { name: string; values: number[] }

export interface LineChartData {
  title?: string
  subtitle?: string
  xLabel?: string
  yLabel?: string
  unit?: string
  valueFormat?: ValueFormat
  precision?: number
  categories: string[]            // shared X labels
  series: LineSeries[]
  fill?: boolean                  // area chart
  smooth?: boolean                // catmull-rom-ish smoothing
  showPoints?: boolean            // overlay point markers (auto if ≤ 30 pts)
}

const W = 480
const PLOT_H = 220
const PAD_TOP = 12
const PAD_BOTTOM = 30
const PAD_LEFT = 56
const PAD_RIGHT = 16
const AXIS_LABEL_GAP = 14

export function LineChart({ data }: { data: LineChartData }): React.ReactElement {
  const categories = data.categories ?? []
  const series = (data.series ?? []).filter((s) => Array.isArray(s.values))
  if (categories.length === 0 || series.length === 0) {
    return null as unknown as React.ReactElement
  }

  const fmt: ValueFormat = data.valueFormat ?? "compact"
  const precision = data.precision ?? 1

  // Determine y-domain
  let minV = Infinity, maxV = -Infinity
  series.forEach((s) => s.values.forEach((v) => {
    if (typeof v !== "number" || !isFinite(v)) return
    if (v < minV) minV = v
    if (v > maxV) maxV = v
  }))
  if (!isFinite(minV)) { minV = 0; maxV = 1 }
  if (minV === maxV) { minV = minV - 1; maxV = maxV + 1 }
  // Don't force 0 baseline for line charts — show the actual range
  const [domMin, domMax] = niceDomain(minV, maxV, 5)
  const ticks = niceTicks(minV, maxV, 5)

  const H = PLOT_H + PAD_TOP + PAD_BOTTOM + (data.xLabel ? AXIS_LABEL_GAP : 0)
  const plotLeft = PAD_LEFT + (data.yLabel ? AXIS_LABEL_GAP : 0)
  const plotRight = W - PAD_RIGHT
  const plotTop = PAD_TOP
  const plotBottom = plotTop + PLOT_H
  const plotW = plotRight - plotLeft

  const xAt = (i: number) => {
    if (categories.length === 1) return plotLeft + plotW / 2
    return plotLeft + (i / (categories.length - 1)) * plotW
  }
  const yAt = (v: number) => plotBottom - ((v - domMin) / (domMax - domMin || 1)) * PLOT_H

  // X labels — thin out if > 12
  const labelStep = Math.max(1, Math.ceil(categories.length / 12))

  const showPoints = data.showPoints ?? (categories.length <= 30)
  const legend = series.length > 1 ? deriveLegend(series.map((s) => s.name)) : undefined

  return (
    <ChartFrame title={data.title} subtitle={data.subtitle} legend={legend} badge={data.fill ? "area" : "line"}>
      <svg width={W} height={H} className="font-mono" style={{ minWidth: W, maxWidth: "100%" }}>
        {/* Y-axis label */}
        {data.yLabel && (
          <text x={12} y={plotTop + PLOT_H / 2} textAnchor="middle"
            fontSize={11} fill="var(--color-text-muted)"
            transform={`rotate(-90 12 ${plotTop + PLOT_H / 2})`}>
            {data.yLabel}
          </text>
        )}

        {/* Gridlines + Y-axis ticks */}
        {ticks.map((t, i) => {
          const y = yAt(t)
          return (
            <g key={i}>
              <line x1={plotLeft} y1={y} x2={plotRight} y2={y} stroke="rgba(255,255,255,0.05)" />
              <text x={plotLeft - 6} y={y + 3} textAnchor="end" fontSize={10} fill="var(--color-text-muted)">{formatTick(t)}</text>
            </g>
          )
        })}

        {/* Series */}
        {series.map((s, si) => {
          const color = pickColor(si)
          const pts = s.values.map((v, i) => ({ x: xAt(i), y: yAt(v), v }))
          const linePath = data.smooth ? smoothPath(pts) : pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ")
          const areaPath = `${linePath} L ${pts[pts.length - 1].x} ${plotBottom} L ${pts[0].x} ${plotBottom} Z`
          return (
            <g key={si}>
              {data.fill && (
                <path d={areaPath} fill={color} fillOpacity={0.18} stroke="none" />
              )}
              <path d={linePath} fill="none" stroke={color} strokeWidth={2}
                strokeLinejoin="round" strokeLinecap="round" />
              {showPoints && pts.map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r={3} fill={color}>
                  <title>{`${s.name} · ${categories[i]}: ${formatValue(p.v, fmt, precision, data.unit)}`}</title>
                </circle>
              ))}
            </g>
          )
        })}

        {/* X-axis category labels */}
        {categories.map((cat, i) => {
          if (i % labelStep !== 0) return null
          return (
            <text key={i} x={xAt(i)} y={plotBottom + 14} textAnchor="middle" fontSize={10} fill="var(--color-text-secondary)">
              {truncate(cat, 12)}
            </text>
          )
        })}

        {/* Axis lines */}
        <line x1={plotLeft} y1={plotBottom} x2={plotRight} y2={plotBottom} stroke="rgba(255,255,255,0.18)" />
        <line x1={plotLeft} y1={plotTop}    x2={plotLeft}  y2={plotBottom} stroke="rgba(255,255,255,0.18)" />

        {/* X-axis label */}
        {data.xLabel && (
          <text x={(plotLeft + plotRight) / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--color-text-muted)">
            {data.xLabel}
          </text>
        )}
      </svg>
    </ChartFrame>
  )
}

// ── Smoothed path (Catmull-Rom → Bezier) ─────────────────────────

function smoothPath(pts: Array<{ x: number; y: number }>): string {
  if (pts.length < 2) return ""
  if (pts.length === 2) return `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`
  const t = 0.4
  const segs: string[] = [`M ${pts[0].x} ${pts[0].y}`]
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] ?? p2
    const cp1x = p1.x + (p2.x - p0.x) * t / 3
    const cp1y = p1.y + (p2.y - p0.y) * t / 3
    const cp2x = p2.x - (p3.x - p1.x) * t / 3
    const cp2y = p2.y - (p3.y - p1.y) * t / 3
    segs.push(`C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`)
  }
  return segs.join(" ")
}

function truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n - 1) + "…" : s }
function Empty(): React.ReactElement {
  return <div className="text-text-muted text-xs italic px-2 py-4">No data</div>
}
