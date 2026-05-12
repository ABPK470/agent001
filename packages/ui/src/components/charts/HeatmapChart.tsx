/**
 * HeatmapChart — 2-D matrix heatmap with row/column labels and a value scale.
 */

import type React from "react"
import { ChartFrame } from "./ChartFrame"
import { divergingColor, formatValue, sequentialColor, type ValueFormat } from "./helpers"

export interface HeatmapChartData {
  title?: string
  subtitle?: string
  xLabel?: string
  yLabel?: string
  unit?: string
  valueFormat?: ValueFormat
  precision?: number
  xCategories: string[]
  yCategories: string[]
  values: number[][]                 // [yIndex][xIndex]
  colorScale?: "sequential" | "diverging"
}

export function HeatmapChart({ data }: { data: HeatmapChartData }): React.ReactElement {
  const xCats = data.xCategories ?? []
  const yCats = data.yCategories ?? []
  const values = data.values ?? []
  if (xCats.length === 0 || yCats.length === 0 || values.length === 0) {
    return null as unknown as React.ReactElement
  }

  const fmt: ValueFormat = data.valueFormat ?? "number"
  const precision = data.precision ?? 1
  const scale = data.colorScale ?? "sequential"

  let minV = Infinity, maxV = -Infinity
  values.forEach((row) => row.forEach((v) => {
    if (typeof v !== "number" || !isFinite(v)) return
    if (v < minV) minV = v
    if (v > maxV) maxV = v
  }))
  if (!isFinite(minV)) { minV = 0; maxV = 1 }
  const absMax = Math.max(Math.abs(minV), Math.abs(maxV)) || 1

  const cellSize = Math.max(20, Math.min(36, 360 / xCats.length))
  const yLabelW = Math.min(120, Math.max(60, longest(yCats) * 6 + 8))
  const xLabelH = 18
  const PAD_LEFT = yLabelW + 8 + (data.yLabel ? 16 : 0)
  const PAD_TOP = 10
  const PAD_RIGHT = 90  // colour-scale legend
  const PAD_BOTTOM = xLabelH + 6 + (data.xLabel ? 16 : 0)

  const W = PAD_LEFT + cellSize * xCats.length + PAD_RIGHT
  const H = PAD_TOP + cellSize * yCats.length + PAD_BOTTOM

  const colorFor = (v: number): string => {
    if (scale === "diverging") return divergingColor(v / absMax)
    if (maxV === minV) return sequentialColor(0.5)
    return sequentialColor((v - minV) / (maxV - minV))
  }

  return (
    <ChartFrame title={data.title} subtitle={data.subtitle} badge="heatmap">
      <svg width={W} height={H} className="font-mono" style={{ minWidth: W, maxWidth: "100%" }}>
        {/* Y-axis label */}
        {data.yLabel && (
          <text x={10} y={PAD_TOP + (cellSize * yCats.length) / 2} textAnchor="middle"
            fontSize={11} fill="var(--color-text-muted)"
            transform={`rotate(-90 10 ${PAD_TOP + (cellSize * yCats.length) / 2})`}>
            {data.yLabel}
          </text>
        )}

        {/* Cells */}
        {yCats.map((_, yi) => xCats.map((_, xi) => {
          const v = values[yi]?.[xi] ?? 0
          const x = PAD_LEFT + xi * cellSize
          const y = PAD_TOP + yi * cellSize
          return (
            <rect key={`${yi}-${xi}`} x={x} y={y} width={cellSize - 1} height={cellSize - 1}
              fill={colorFor(v)} rx={2}>
              <title>{`${yCats[yi]} × ${xCats[xi]}: ${formatValue(v, fmt, precision, data.unit)}`}</title>
            </rect>
          )
        }))}

        {/* Inline cell values when grid is small */}
        {xCats.length * yCats.length <= 100 && yCats.map((_, yi) => xCats.map((_, xi) => {
          const v = values[yi]?.[xi]
          if (typeof v !== "number") return null
          const x = PAD_LEFT + xi * cellSize + cellSize / 2
          const y = PAD_TOP + yi * cellSize + cellSize / 2 + 3
          return (
            <text key={`v-${yi}-${xi}`} x={x} y={y} textAnchor="middle" fontSize={9} fill="var(--color-text)">
              {formatValue(v, fmt, precision)}
            </text>
          )
        }))}

        {/* Y category labels */}
        {yCats.map((cat, yi) => (
          <text key={`yl-${yi}`}
            x={PAD_LEFT - 6} y={PAD_TOP + yi * cellSize + cellSize / 2 + 3}
            textAnchor="end" fontSize={10} fill="var(--color-text-secondary)">
            {truncate(cat, 18)}
          </text>
        ))}

        {/* X category labels */}
        {xCats.map((cat, xi) => (
          <text key={`xl-${xi}`}
            x={PAD_LEFT + xi * cellSize + cellSize / 2}
            y={PAD_TOP + cellSize * yCats.length + 14}
            textAnchor="middle" fontSize={10} fill="var(--color-text-secondary)">
            {truncate(cat, 8)}
          </text>
        ))}

        {/* X-axis label */}
        {data.xLabel && (
          <text x={PAD_LEFT + (cellSize * xCats.length) / 2} y={H - 4}
            textAnchor="middle" fontSize={11} fill="var(--color-text-muted)">
            {data.xLabel}
          </text>
        )}

        {/* Colour scale legend */}
        <ColorScale x={W - PAD_RIGHT + 14} y={PAD_TOP} height={cellSize * yCats.length}
          minV={scale === "diverging" ? -absMax : minV}
          maxV={scale === "diverging" ?  absMax : maxV}
          fmt={fmt} precision={precision} unit={data.unit} scale={scale} />
      </svg>
    </ChartFrame>
  )
}

function ColorScale({ x, y, height, minV, maxV, fmt, precision, unit, scale }: {
  x: number; y: number; height: number; minV: number; maxV: number
  fmt: ValueFormat; precision: number; unit?: string
  scale: "sequential" | "diverging"
}): React.ReactElement {
  const W = 12
  const STEPS = 24
  const stops: React.ReactNode[] = []
  for (let i = 0; i < STEPS; i++) {
    const t = i / (STEPS - 1)
    const v = minV + t * (maxV - minV)
    const c = scale === "diverging" ? divergingColor(v / Math.max(Math.abs(minV), Math.abs(maxV) || 1)) : sequentialColor(t)
    stops.push(<rect key={i} x={x} y={y + height - (i + 1) * (height / STEPS)} width={W} height={height / STEPS + 0.5} fill={c} />)
  }
  return (
    <g>
      {stops}
      <text x={x + W + 4} y={y + 8} fontSize={10} fill="var(--color-text-muted)">{formatValue(maxV, fmt, precision, unit)}</text>
      <text x={x + W + 4} y={y + height} fontSize={10} fill="var(--color-text-muted)">{formatValue(minV, fmt, precision, unit)}</text>
    </g>
  )
}

function truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n - 1) + "…" : s }
function longest(arr: string[]): number { return arr.reduce((m, s) => Math.max(m, s.length), 0) }
