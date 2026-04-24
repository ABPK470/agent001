/**
 * KpiCards — grid of stat cards. Each card shows a big value, a delta (optional)
 * with directional colouring, and an optional sparkline.
 */

import type React from "react"
import { ChartFrame } from "./ChartFrame"
import { formatValue, pickColor, type ValueFormat } from "./helpers"

export interface KpiCard {
  label: string
  value: number
  unit?: string
  valueFormat?: ValueFormat
  precision?: number
  delta?: number
  deltaUnit?: string
  /** Direction the delta represents — defaults to inferred from sign. */
  deltaDirection?: "up" | "down" | "flat"
  /** Which direction is "good" — used for colour cue. */
  good?: "up" | "down" | "neutral"
  sparkline?: number[]
}

export interface KpiCardsData {
  title?: string
  subtitle?: string
  columns?: number
  cards: KpiCard[]
}

export function KpiCards({ data }: { data: KpiCardsData }): React.ReactElement {
  const cards = data.cards ?? []
  const cols = Math.max(1, Math.min(data.columns ?? Math.min(4, cards.length), 6))

  return (
    <ChartFrame title={data.title} subtitle={data.subtitle} badge="kpi">
      <div className="grid gap-2.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {cards.map((c, i) => <Card key={i} card={c} accent={pickColor(i)} />)}
      </div>
    </ChartFrame>
  )
}

function Card({ card, accent }: { card: KpiCard; accent: string }): React.ReactElement {
  const fmt: ValueFormat = card.valueFormat ?? "compact"
  const precision = card.precision ?? 1
  const deltaDir = card.deltaDirection ?? (card.delta == null ? "flat" : card.delta > 0 ? "up" : card.delta < 0 ? "down" : "flat")
  const good = card.good ?? "neutral"
  const isGood =
    good === "neutral" ? null :
    (good === "up" && deltaDir === "up") || (good === "down" && deltaDir === "down")
  const deltaColor =
    isGood == null ? "text-text-muted"
    : isGood ? "text-success"
    : "text-error"

  return (
    <div className="rounded-md border border-white/[0.06] bg-white/[0.02] p-2.5 flex flex-col gap-1 min-w-0">
      <div className="text-[11px] text-text-muted truncate" title={card.label}>{card.label}</div>
      <div className="text-lg font-semibold text-text tabular-nums leading-tight">
        {formatValue(card.value, fmt, precision, card.unit)}
      </div>
      {card.delta != null && (
        <div className={`text-[11px] tabular-nums ${deltaColor}`}>
          {deltaDir === "up" ? "▲" : deltaDir === "down" ? "▼" : "—"}{" "}
          {Math.abs(card.delta).toFixed(precision)}{card.deltaUnit ?? ""}
        </div>
      )}
      {card.sparkline && card.sparkline.length > 1 && (
        <Sparkline values={card.sparkline} color={accent} />
      )}
    </div>
  )
}

function Sparkline({ values, color }: { values: number[]; color: string }): React.ReactElement {
  const W = 100, H = 24
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const step = W / (values.length - 1)
  const path = values.map((v, i) => {
    const x = i * step
    const y = H - ((v - min) / range) * (H - 4) - 2
    return `${i === 0 ? "M" : "L"} ${x} ${y}`
  }).join(" ")
  const areaPath = `${path} L ${W} ${H} L 0 ${H} Z`
  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-0.5">
      <path d={areaPath} fill={color} fillOpacity={0.15} />
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
