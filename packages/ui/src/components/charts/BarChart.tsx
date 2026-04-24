/**
 * BarChart — vertical or horizontal bars, single series, grouped series,
 * or stacked series. Always renders title, axis labels, value axis ticks
 * and a legend (when multi-series).
 */

import type React from "react";
import { ChartFrame, deriveLegend } from "./ChartFrame";
import { CHART_PALETTE, formatTick, formatValue, niceDomain, niceTicks, pickColor, type ValueFormat } from "./helpers";

export interface BarSeries { name: string; values: number[] }

export interface BarChartData {
  title?: string
  subtitle?: string
  xLabel?: string
  yLabel?: string
  unit?: string
  valueFormat?: ValueFormat
  precision?: number
  orientation?: "vertical" | "horizontal"
  stacked?: boolean
  categories?: string[]
  series?: BarSeries[]
  // Legacy shape support
  rows?: Array<{ label: string; value: number; sublabel?: string }>
}

const PLOT_W = 460
const PLOT_H_VERT = 220
const PLOT_H_PER_BAR = 26
const PAD_TOP = 12
const PAD_BOTTOM = 30
const PAD_LEFT = 56
const PAD_RIGHT = 16
const AXIS_LABEL_GAP = 14

export function BarChart({ data }: { data: BarChartData }): React.ReactElement {
  // Normalise legacy shape
  let categories: string[]
  let series: BarSeries[]
  if (data.rows && data.rows.length > 0) {
    categories = data.rows.map((r) => r.label)
    series = [{ name: data.title ?? "value", values: data.rows.map((r) => r.value) }]
  } else {
    categories = data.categories ?? []
    series = (data.series ?? []).filter((s) => Array.isArray(s.values))
  }

  if (categories.length === 0 || series.length === 0) {
    return <ChartFrame title={data.title} badge="bar"><EmptyState /></ChartFrame>
  }

  const orientation = data.orientation ?? "vertical"
  const stacked = !!data.stacked && series.length > 1
  const fmt: ValueFormat = data.valueFormat ?? "compact"
  const precision = data.precision ?? 1

  // Determine value-axis range
  const valueAtIndex = (i: number) => series.map((s) => s.values[i] ?? 0)
  let minV = 0
  let maxV = 0
  if (stacked) {
    categories.forEach((_, i) => {
      const sum = valueAtIndex(i).reduce((a, b) => a + b, 0)
      if (sum > maxV) maxV = sum
      if (sum < minV) minV = sum
    })
  } else {
    series.forEach((s) => s.values.forEach((v) => {
      if (v > maxV) maxV = v
      if (v < minV) minV = v
    }))
  }
  if (minV === 0 && maxV === 0) maxV = 1
  const [domMin, domMax] = niceDomain(minV, maxV, 5)
  const ticks = niceTicks(minV, maxV, 5)

  const legend = series.length > 1 ? deriveLegend(series.map((s) => s.name)) : undefined

  return (
    <ChartFrame title={data.title} subtitle={data.subtitle} legend={legend} badge="bar">
      {orientation === "vertical"
        ? <VerticalBars categories={categories} series={series} stacked={stacked}
            domMin={domMin} domMax={domMax} ticks={ticks}
            xLabel={data.xLabel} yLabel={data.yLabel} unit={data.unit} fmt={fmt} precision={precision} />
        : <HorizontalBars categories={categories} series={series} stacked={stacked}
            domMin={domMin} domMax={domMax} ticks={ticks}
            xLabel={data.xLabel} yLabel={data.yLabel} unit={data.unit} fmt={fmt} precision={precision} />}
    </ChartFrame>
  )
}

// ── Vertical bars (categories on X) ──────────────────────────────

function VerticalBars(props: {
  categories: string[]; series: BarSeries[]; stacked: boolean
  domMin: number; domMax: number; ticks: number[]
  xLabel?: string; yLabel?: string; unit?: string
  fmt: ValueFormat; precision: number
}): React.ReactElement {
  const { categories, series, stacked, domMin, domMax, ticks, xLabel, yLabel, unit, fmt, precision } = props
  const W = PLOT_W
  const H = PLOT_H_VERT + PAD_TOP + PAD_BOTTOM + (xLabel ? AXIS_LABEL_GAP : 0) + (yLabel ? AXIS_LABEL_GAP : 0)
  const plotLeft = PAD_LEFT + (yLabel ? AXIS_LABEL_GAP : 0)
  const plotRight = W - PAD_RIGHT
  const plotTop = PAD_TOP
  const plotBottom = PAD_TOP + PLOT_H_VERT
  const plotW = plotRight - plotLeft

  const bandW = plotW / categories.length
  const innerPad = 0.18
  const groupW = bandW * (1 - innerPad * 2)
  const subBarW = stacked ? groupW : groupW / series.length

  const yScale = (v: number) => plotBottom - ((v - domMin) / (domMax - domMin || 1)) * PLOT_H_VERT

  return (
    <svg width={W} height={H} className="font-mono" style={{ minWidth: W, maxWidth: "100%" }}>
      {/* Y-axis label */}
      {yLabel && (
        <text x={12} y={plotTop + PLOT_H_VERT / 2} textAnchor="middle"
          fontSize={11} fill="#a1a1aa"
          transform={`rotate(-90 12 ${plotTop + PLOT_H_VERT / 2})`}>
          {yLabel}
        </text>
      )}

      {/* Gridlines + Y-axis ticks */}
      {ticks.map((t, i) => {
        const y = yScale(t)
        return (
          <g key={i}>
            <line x1={plotLeft} y1={y} x2={plotRight} y2={y} stroke="rgba(255,255,255,0.05)" />
            <text x={plotLeft - 6} y={y + 3} textAnchor="end" fontSize={10} fill="#a1a1aa">{formatTick(t)}</text>
          </g>
        )
      })}

      {/* Zero baseline (if domain spans zero) */}
      {domMin < 0 && domMax > 0 && (
        <line x1={plotLeft} y1={yScale(0)} x2={plotRight} y2={yScale(0)} stroke="rgba(255,255,255,0.18)" />
      )}

      {/* Bars */}
      {categories.map((cat, ci) => {
        const groupX = plotLeft + bandW * ci + bandW * innerPad
        let stackPos = 0
        let stackNeg = 0
        return (
          <g key={ci}>
            {series.map((s, si) => {
              const v = s.values[ci] ?? 0
              const color = pickColor(si)
              if (stacked) {
                const base = v >= 0 ? stackPos : stackNeg
                const top = v >= 0 ? stackPos + v : stackNeg + v
                const yTop = yScale(Math.max(base, top))
                const yBot = yScale(Math.min(base, top))
                if (v >= 0) stackPos = top; else stackNeg = top
                return (
                  <rect key={si} x={groupX} y={yTop} width={subBarW} height={Math.max(yBot - yTop, 0)}
                    fill={color} rx={2}>
                    <title>{`${s.name} · ${cat}: ${formatValue(v, fmt, precision, unit)}`}</title>
                  </rect>
                )
              }
              const x = groupX + si * subBarW
              const yTop = yScale(Math.max(v, 0))
              const yBot = yScale(Math.min(v, 0))
              return (
                <g key={si}>
                  <rect x={x} y={yTop} width={Math.max(subBarW - 1, 1)} height={Math.max(yBot - yTop, 0)}
                    fill={color} rx={2}>
                    <title>{`${s.name} · ${cat}: ${formatValue(v, fmt, precision, unit)}`}</title>
                  </rect>
                  {/* Value label above bar (only when there's room and ≤ 8 bars per category) */}
                  {series.length === 1 && categories.length <= 12 && (
                    <text x={x + subBarW / 2} y={yTop - 3} textAnchor="middle" fontSize={9} fill="#d4d4d8">
                      {formatValue(v, fmt, precision)}
                    </text>
                  )}
                </g>
              )
            })}
            {/* Category label */}
            <text x={groupX + groupW / 2} y={plotBottom + 14} textAnchor="middle" fontSize={10} fill="#d4d4d8">
              {truncate(cat, Math.max(Math.floor(bandW / 7), 4))}
            </text>
          </g>
        )
      })}

      {/* X-axis label */}
      {xLabel && (
        <text x={(plotLeft + plotRight) / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="#a1a1aa">
          {xLabel}
        </text>
      )}

      {/* Axis lines */}
      <line x1={plotLeft} y1={plotBottom} x2={plotRight} y2={plotBottom} stroke="rgba(255,255,255,0.18)" />
      <line x1={plotLeft} y1={plotTop} x2={plotLeft} y2={plotBottom} stroke="rgba(255,255,255,0.18)" />
    </svg>
  )
}

// ── Horizontal bars (categories on Y) ────────────────────────────

function HorizontalBars(props: {
  categories: string[]; series: BarSeries[]; stacked: boolean
  domMin: number; domMax: number; ticks: number[]
  xLabel?: string; yLabel?: string; unit?: string
  fmt: ValueFormat; precision: number
}): React.ReactElement {
  const { categories, series, stacked, domMin, domMax, ticks, xLabel, yLabel, unit, fmt, precision } = props
  const plotH = Math.max(PLOT_H_PER_BAR * categories.length, PLOT_H_PER_BAR)
  const labelW = Math.min(160, Math.max(80, longest(categories) * 6 + 12))
  const W = labelW + 24 + 320 + PAD_RIGHT
  const H = plotH + PAD_TOP + PAD_BOTTOM + (xLabel ? AXIS_LABEL_GAP : 0)
  const plotLeft = labelW + 12
  const plotRight = W - PAD_RIGHT
  const plotTop = PAD_TOP
  const plotBottom = plotTop + plotH
  const plotW = plotRight - plotLeft

  const xScale = (v: number) => plotLeft + ((v - domMin) / (domMax - domMin || 1)) * plotW
  const bandH = plotH / categories.length
  const innerPad = 0.18
  const groupH = bandH * (1 - innerPad * 2)
  const subBarH = stacked ? groupH : groupH / series.length

  return (
    <svg width={W} height={H} className="font-mono" style={{ minWidth: W, maxWidth: "100%" }}>
      {/* Gridlines + X-axis ticks */}
      {ticks.map((t, i) => {
        const x = xScale(t)
        return (
          <g key={i}>
            <line x1={x} y1={plotTop} x2={x} y2={plotBottom} stroke="rgba(255,255,255,0.05)" />
            <text x={x} y={plotBottom + 14} textAnchor="middle" fontSize={10} fill="#a1a1aa">{formatTick(t)}</text>
          </g>
        )
      })}

      {/* Bars */}
      {categories.map((cat, ci) => {
        const groupY = plotTop + bandH * ci + bandH * innerPad
        let stackPos = 0
        let stackNeg = 0
        return (
          <g key={ci}>
            {/* Category label */}
            <text x={plotLeft - 8} y={groupY + groupH / 2 + 3} textAnchor="end" fontSize={10} fill="#d4d4d8">
              {truncate(cat, 22)}
            </text>
            {series.map((s, si) => {
              const v = s.values[ci] ?? 0
              const color = pickColor(si)
              if (stacked) {
                const base = v >= 0 ? stackPos : stackNeg
                const top = v >= 0 ? stackPos + v : stackNeg + v
                const xLeft = xScale(Math.min(base, top))
                const xRight = xScale(Math.max(base, top))
                if (v >= 0) stackPos = top; else stackNeg = top
                return (
                  <rect key={si} x={xLeft} y={groupY} width={Math.max(xRight - xLeft, 0)} height={groupH}
                    fill={color} rx={2}>
                    <title>{`${s.name} · ${cat}: ${formatValue(v, fmt, precision, unit)}`}</title>
                  </rect>
                )
              }
              const y = groupY + si * subBarH
              const xLeft = xScale(Math.min(v, 0))
              const xRight = xScale(Math.max(v, 0))
              return (
                <g key={si}>
                  <rect x={xLeft} y={y} width={Math.max(xRight - xLeft, 0)} height={Math.max(subBarH - 1, 1)}
                    fill={color} rx={2}>
                    <title>{`${s.name} · ${cat}: ${formatValue(v, fmt, precision, unit)}`}</title>
                  </rect>
                  {/* Inline value */}
                  {series.length === 1 && (
                    <text x={xRight + 4} y={y + subBarH / 2 + 3} fontSize={9.5} fill="#d4d4d8">
                      {formatValue(v, fmt, precision, unit)}
                    </text>
                  )}
                </g>
              )
            })}
          </g>
        )
      })}

      {/* Zero baseline */}
      {domMin < 0 && domMax > 0 && (
        <line x1={xScale(0)} y1={plotTop} x2={xScale(0)} y2={plotBottom} stroke="rgba(255,255,255,0.18)" />
      )}

      {/* Axis lines */}
      <line x1={plotLeft} y1={plotBottom} x2={plotRight} y2={plotBottom} stroke="rgba(255,255,255,0.18)" />
      <line x1={plotLeft} y1={plotTop}    x2={plotLeft}  y2={plotBottom} stroke="rgba(255,255,255,0.18)" />

      {/* Axis labels */}
      {xLabel && (
        <text x={(plotLeft + plotRight) / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="#a1a1aa">
          {xLabel}
        </text>
      )}
      {yLabel && (
        <text x={12} y={plotTop + plotH / 2} textAnchor="middle"
          fontSize={11} fill="#a1a1aa"
          transform={`rotate(-90 12 ${plotTop + plotH / 2})`}>
          {yLabel}
        </text>
      )}
    </svg>
  )
}

// ── Helpers ──────────────────────────────────────────────────────

function truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n - 1) + "…" : s }
function longest(arr: string[]): number { return arr.reduce((m, s) => Math.max(m, s.length), 0) }

function EmptyState(): React.ReactElement {
  return <div className="text-text-muted text-xs italic px-2 py-4">No data</div>
}

// Re-export palette for callers that compose charts manually
export { CHART_PALETTE };

