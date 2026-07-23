export { CHART_KINDS, isChartKind, type ChartKind } from "./render-chart"
export { Dashboard, type DashboardData } from "./Dashboard"

import type React from "react"
import { Dashboard, type DashboardData } from "./Dashboard"
import { renderChart as renderLeafChart, type ChartKind } from "./render-chart"

export function renderChart(kind: ChartKind, spec: unknown): React.ReactElement {
  if (kind === "dashboard") return <Dashboard data={spec as DashboardData} />
  return renderLeafChart(kind, spec)
}
