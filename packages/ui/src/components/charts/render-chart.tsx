import type React from "react"
import { BarChart, type BarChartData } from "./BarChart"
import { HeatmapChart, type HeatmapChartData } from "./HeatmapChart"
import { KpiCards, type KpiCardsData } from "./KpiCards"
import { LineChart, type LineChartData } from "./LineChart"
import { PieChart, type PieChartData } from "./PieChart"
import { ScatterChart, type ScatterChartData } from "./ScatterChart"

export const CHART_KINDS = [
  "bar", "line", "area", "pie", "donut",
  "scatter", "heatmap", "kpi", "dashboard",
] as const

export type ChartKind = (typeof CHART_KINDS)[number]

export function isChartKind(s: string): s is ChartKind {
  return (CHART_KINDS as readonly string[]).includes(s)
}

export function renderChart(kind: ChartKind, spec: unknown): React.ReactElement {
  switch (kind) {
    case "bar":       return <BarChart    data={spec as BarChartData} />
    case "line":      return <LineChart   data={spec as LineChartData} />
    case "area":      return <LineChart   data={{ ...(spec as LineChartData), fill: true }} />
    case "pie":       return <PieChart    data={spec as PieChartData} />
    case "donut":     return <PieChart    data={{ ...(spec as PieChartData), donut: true }} />
    case "scatter":   return <ScatterChart data={spec as ScatterChartData} />
    case "heatmap":   return <HeatmapChart data={spec as HeatmapChartData} />
    case "kpi":       return <KpiCards    data={spec as KpiCardsData} />
    case "dashboard": throw new Error("dashboard rendering is handled by Dashboard.tsx")
  }
}
