/**
 * ScatterChart — multi-series scatter plot with x/y numeric axes.
 */

import type React from "react";
import { ChartFrame, deriveLegend } from "./ChartFrame";
import { formatTick, formatValue, niceDomain, niceTicks, pickColor, type ValueFormat } from "./helpers";

export interface ScatterPoint { x: number; y: number; label?: string; size?: number }
export interface ScatterSeries { name: string; points: ScatterPoint[] }

export interface ScatterChartData {
  title?: string
  subtitle?: string
  xLabel?: string
  yLabel?: string
  unit?: string
  valueFormat?: ValueFormat
  precision?: number
  series: ScatterSeries[]
}

const W = 480
const PLOT_H = 240
const PAD_TOP = 12
const PAD_BOTTOM = 30
const PAD_LEFT = 56
const PAD_RIGHT = 16
const AXIS_LABEL_GAP = 14

export function ScatterChart({ data }: { data: ScatterChartData }): React.ReactElement {
  const series = (data.series ?? []).filter((s) => Array.isArray(s.points) && s.points.length > 0)
  if (series.length === 0) {
    return <ChartFrame title={data.title} badge="scatter">
      <div className="text-text-muted text-xs italic px-2 py-4">No data</div>
    </ChartFrame>
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  series.forEach((s) => s.points.forEach((p) => {
    if (typeof p.x !== "number" || typeof p.y !== "number") return
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y
  }))
  if (!isFinite(minX)) { minX = 0; maxX = 1; minY = 0; maxY = 1 }
  if (minX === maxX) { minX -= 1; maxX += 1 }
  if (minY === maxY) { minY -= 1; maxY += 1 }

  const [xDomMin, xDomMax] = niceDomain(minX, maxX, 5)
  const [yDomMin, yDomMax] = niceDomain(minY, maxY, 5)
  const xTicks = niceTicks(minX, maxX, 5)
  const yTicks = niceTicks(minY, maxY, 5)

  const fmt: ValueFormat = data.valueFormat ?? "number"
  const precision = data.precision ?? 2

  const H = PLOT_H + PAD_TOP + PAD_BOTTOM + (data.xLabel ? AXIS_LABEL_GAP : 0)
  const plotLeft = PAD_LEFT + (data.yLabel ? AXIS_LABEL_GAP : 0)
  const plotRight = W - PAD_RIGHT
  const plotTop = PAD_TOP
  const plotBottom = plotTop + PLOT_H
  const plotW = plotRight - plotLeft

  const xAt = (v: number) => plotLeft + ((v - xDomMin) / (xDomMax - xDomMin || 1)) * plotW
  const yAt = (v: number) => plotBottom - ((v - yDomMin) / (yDomMax - yDomMin || 1)) * PLOT_H

  const legend = series.length > 1 ? deriveLegend(series.map((s) => s.name)) : undefined

  return (
    <ChartFrame title={data.title} subtitle={data.subtitle} legend={legend} badge="scatter">
      <svg width={W} height={H} className="font-mono" style={{ minWidth: W, maxWidth: "100%" }}>
        {data.yLabel && (
          <text x={12} y={plotTop + PLOT_H / 2} textAnchor="middle"
            fontSize={11} fill="#a1a1aa"
            transform={`rotate(-90 12 ${plotTop + PLOT_H / 2})`}>
            {data.yLabel}
          </text>
        )}

        {/* Y gridlines + ticks */}
        {yTicks.map((t, i) => {
          const y = yAt(t)
          return (
            <g key={i}>
              <line x1={plotLeft} y1={y} x2={plotRight} y2={y} stroke="rgba(255,255,255,0.05)" />
              <text x={plotLeft - 6} y={y + 3} textAnchor="end" fontSize={10} fill="#a1a1aa">{formatTick(t)}</text>
            </g>
          )
        })}

        {/* X ticks */}
        {xTicks.map((t, i) => {
          const x = xAt(t)
          return (
            <g key={`xt-${i}`}>
              <line x1={x} y1={plotTop} x2={x} y2={plotBottom} stroke="rgba(255,255,255,0.05)" />
              <text x={x} y={plotBottom + 14} textAnchor="middle" fontSize={10} fill="#a1a1aa">{formatTick(t)}</text>
            </g>
          )
        })}

        {/* Points */}
        {series.map((s, si) => {
          const color = pickColor(si)
          return s.points.map((p, pi) => {
            const r = p.size ?? 4
            return (
              <circle key={`${si}-${pi}`} cx={xAt(p.x)} cy={yAt(p.y)} r={r}
                fill={color} fillOpacity={0.7} stroke={color} strokeWidth={1}>
                <title>
                  {`${p.label ?? s.name}\n${data.xLabel ?? "x"}: ${formatValue(p.x, fmt, precision)}\n${data.yLabel ?? "y"}: ${formatValue(p.y, fmt, precision, data.unit)}`}
                </title>
              </circle>
            )
          })
        })}

        <line x1={plotLeft} y1={plotBottom} x2={plotRight} y2={plotBottom} stroke="rgba(255,255,255,0.18)" />
        <line x1={plotLeft} y1={plotTop}    x2={plotLeft}  y2={plotBottom} stroke="rgba(255,255,255,0.18)" />

        {data.xLabel && (
          <text x={(plotLeft + plotRight) / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="#a1a1aa">
            {data.xLabel}
          </text>
        )}
      </svg>
    </ChartFrame>
  )
}
