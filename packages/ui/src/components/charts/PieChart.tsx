/**
 * PieChart — pie or donut chart, with side legend showing labels + values + %.
 */

import type React from "react";
import { ChartFrame } from "./ChartFrame";
import { formatValue, pickColor, type ValueFormat } from "./helpers";

export interface PieSlice { label: string; value: number; color?: string }

export interface PieChartData {
  title?: string
  subtitle?: string
  unit?: string
  valueFormat?: ValueFormat
  precision?: number
  donut?: boolean
  slices: PieSlice[]
}

export function PieChart({ data }: { data: PieChartData }): React.ReactElement {
  const slices = (data.slices ?? []).filter((s) => typeof s.value === "number" && isFinite(s.value) && s.value > 0)
  if (slices.length === 0) {
    return null as unknown as React.ReactElement
  }

  const total = slices.reduce((a, s) => a + s.value, 0)
  const fmt: ValueFormat = data.valueFormat ?? "compact"
  const precision = data.precision ?? 1

  const SIZE = 200
  const cx = SIZE / 2
  const cy = SIZE / 2
  const r = SIZE / 2 - 6
  const innerR = data.donut ? r * 0.6 : 0

  let acc = 0
  const segments = slices.map((s, i) => {
    const start = acc / total
    acc += s.value
    const end = acc / total
    const color = s.color ?? pickColor(i)
    const path = arcPath(cx, cy, r, innerR, start, end)
    const pct = (s.value / total) * 100
    return { ...s, color, path, pct, start, end }
  })

  return (
    <ChartFrame title={data.title} subtitle={data.subtitle} badge={data.donut ? "donut" : "pie"}>
      <div className="flex items-start gap-4 flex-wrap">
        <svg width={SIZE} height={SIZE} className="font-mono shrink-0">
          {segments.map((s, i) => (
            <path key={i} d={s.path} fill={s.color} stroke="var(--color-canvas)" strokeWidth={1.5}>
              <title>{`${s.label}: ${formatValue(s.value, fmt, precision, data.unit)} (${s.pct.toFixed(1)}%)`}</title>
            </path>
          ))}
          {data.donut && (
            <text x={cx} y={cy + 4} textAnchor="middle" fontSize={13} fill="var(--color-text)" fontWeight="600">
              {formatValue(total, fmt, precision, data.unit)}
            </text>
          )}
        </svg>

        <div className="flex-1 min-w-[160px] space-y-1">
          {segments.map((s, i) => (
            <div key={i} className="flex items-center gap-2 text-[11px]">
              <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: s.color }} />
              <span className="text-text-secondary truncate flex-1" title={s.label}>{s.label}</span>
              <span className="text-text font-medium tabular-nums">{formatValue(s.value, fmt, precision, data.unit)}</span>
              <span className="text-text-muted tabular-nums w-10 text-right">{s.pct.toFixed(1)}%</span>
            </div>
          ))}
        </div>
      </div>
    </ChartFrame>
  )
}

// ── Arc path (handles full circle and pie/donut) ─────────────────

function arcPath(cx: number, cy: number, r: number, innerR: number, t0: number, t1: number): string {
  // Almost-full slice handling: split into two arcs to avoid 360° == 0° degenerate case
  if (t1 - t0 >= 0.999) {
    if (innerR > 0) {
      return [
        `M ${cx + r} ${cy}`,
        `A ${r} ${r} 0 1 1 ${cx - r} ${cy}`,
        `A ${r} ${r} 0 1 1 ${cx + r} ${cy}`,
        `M ${cx + innerR} ${cy}`,
        `A ${innerR} ${innerR} 0 1 0 ${cx - innerR} ${cy}`,
        `A ${innerR} ${innerR} 0 1 0 ${cx + innerR} ${cy}`,
        "Z",
      ].join(" ")
    }
    return `M ${cx} ${cy} m -${r} 0 a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 -${r * 2} 0 Z`
  }

  const a0 = t0 * Math.PI * 2 - Math.PI / 2
  const a1 = t1 * Math.PI * 2 - Math.PI / 2
  const largeArc = (t1 - t0) > 0.5 ? 1 : 0
  const x0 = cx + Math.cos(a0) * r,    y0 = cy + Math.sin(a0) * r
  const x1 = cx + Math.cos(a1) * r,    y1 = cy + Math.sin(a1) * r

  if (innerR > 0) {
    const xi0 = cx + Math.cos(a0) * innerR, yi0 = cy + Math.sin(a0) * innerR
    const xi1 = cx + Math.cos(a1) * innerR, yi1 = cy + Math.sin(a1) * innerR
    return [
      `M ${x0} ${y0}`,
      `A ${r} ${r} 0 ${largeArc} 1 ${x1} ${y1}`,
      `L ${xi1} ${yi1}`,
      `A ${innerR} ${innerR} 0 ${largeArc} 0 ${xi0} ${yi0}`,
      "Z",
    ].join(" ")
  }
  return [
    `M ${cx} ${cy}`,
    `L ${x0} ${y0}`,
    `A ${r} ${r} 0 ${largeArc} 1 ${x1} ${y1}`,
    "Z",
  ].join(" ")
}
