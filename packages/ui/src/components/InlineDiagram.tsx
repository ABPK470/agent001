/**
 * InlineDiagram — dispatcher for inline visualisations rendered inside chat
 * answers. The agent emits a fenced code block whose language tag selects a
 * renderer:
 *
 *   ```relationships  — entity boxes + labelled edges (ER diagram)
 *   ```flow           — directed graph (alias for relationships)
 *   ```bar            — vertical/horizontal/grouped/stacked bar chart
 *   ```line           — multi-series line chart
 *   ```area           — line chart with filled area
 *   ```pie / ```donut — pie / donut chart with legend
 *   ```scatter        — x/y scatter plot
 *   ```heatmap        — 2-D matrix heatmap
 *   ```kpi            — grid of stat cards (with optional sparklines)
 *   ```dashboard      — 12-column grid composing any of the above
 *
 * Charting components live in ./charts/ and never load external libraries.
 */

import type React from "react"
import { Dashboard, type DashboardData } from "./charts/Dashboard"
import { RelationshipsDiagram, type RelationshipsData } from "./charts/RelationshipsDiagram"
import { isChartKind, renderChart, type ChartKind } from "./charts/render-chart"

const GRAPH_KINDS = ["relationships", "flow"] as const
type GraphKind = (typeof GRAPH_KINDS)[number]

export type DiagramKind = ChartKind | GraphKind

export function isDiagramLang(lang: string): lang is DiagramKind {
  return isChartKind(lang) || (GRAPH_KINDS as readonly string[]).includes(lang as GraphKind)
}

/** Attempt to recognise a chart/diagram payload inside a generic ```json fence
 *  that the agent emitted with the wrong language tag. Returns the inferred
 *  diagram kind or null if the JSON does not look like a known chart spec. */
export function tryInferDiagramKind(source: string): DiagramKind | null {
  let payload: unknown
  try { payload = JSON.parse(source) } catch { return null }
  if (!payload || typeof payload !== "object") return null
  const p = payload as Record<string, unknown>

  // Explicit hint wins.
  for (const field of ["kind", "type", "chart"] as const) {
    const v = p[field]
    if (typeof v === "string") {
      const k = v.toLowerCase()
      if (isChartKind(k) || (GRAPH_KINDS as readonly string[]).includes(k as GraphKind)) return k as DiagramKind
    }
  }

  // Shape-based inference — be conservative so plain JSON examples don't get hijacked.
  if (Array.isArray(p.nodes) && p.nodes.length > 0 && Array.isArray(p.edges)) return "relationships"
  if (Array.isArray(p.items) && p.items.length > 0 && typeof (p.items[0] as Record<string, unknown>)?.width === "number") return "dashboard"
  if (Array.isArray(p.cards) && p.cards.length > 0) return "kpi"
  if (Array.isArray(p.kpis) && p.kpis.length > 0) return "kpi"
  if (Array.isArray(p.matrix) && Array.isArray(p.rows) && Array.isArray(p.columns)) return "heatmap"
  if (Array.isArray(p.points) && p.points.length > 0 && typeof (p.points[0] as Record<string, unknown>)?.x === "number") return "scatter"
  if (Array.isArray(p.slices) && p.slices.length > 0) return "pie"
  // For series+categories the explicit "smooth"/x-axis hints distinguish line from bar.
  if (Array.isArray(p.series) && Array.isArray(p.categories)) {
    if (p.smooth === true || p.showPoints !== undefined || p.xLabel !== undefined) return "line"
    return "bar"
  }
  // Bare series without categories is likely a line chart
  if (Array.isArray(p.series) && p.series.length > 0) return "line"
  return null
}

export function InlineDiagram({ kind, source }: { kind: DiagramKind; source: string }): React.ReactElement {
  let payload: unknown
  try {
    payload = JSON.parse(source)
  } catch (e) {
    return <DiagramError kind={kind} source={source} message={e instanceof Error ? e.message : "Invalid JSON"} />
  }

  try {
    if (kind === "relationships" || kind === "flow") {
      return <RelationshipsDiagram data={payload as RelationshipsData} kind={kind} />
    }
    if (kind === "dashboard") {
      return <Dashboard data={payload as DashboardData} />
    }
    return renderChart(kind, payload)
  } catch (e) {
    return <DiagramError kind={kind} source={source} message={e instanceof Error ? e.message : "Render failed"} />
  }
}

function DiagramError({ kind, source, message }: { kind: string; source: string; message: string }): React.ReactElement {
  return (
    <div className="rounded-lg overflow-hidden border border-border-subtle">
      <div className="px-3 py-1 text-[11px] text-error font-mono border-b border-border-subtle">
        {kind} (parse error: {message})
      </div>
      <pre className="px-3 py-2.5 text-[12px] font-mono text-text-secondary overflow-x-auto">{source}</pre>
    </div>
  )
}

// ── Relationships / flow diagram ─────────────────────────────────
// See charts/RelationshipsDiagram.tsx

