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
import { isChartKind, renderChart, type ChartKind } from "./charts"

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
// Layered-DAG layout (BFS from inbound-zero nodes). Good for ≤ 30 nodes.

interface RelNode { id: string; label?: string; subtitle?: string }
interface RelEdge { from: string; to: string; label?: string }
interface RelationshipsData { nodes: RelNode[]; edges?: RelEdge[]; title?: string; subtitle?: string }

function RelationshipsDiagram({ data, kind }: { data: RelationshipsData; kind: GraphKind }): React.ReactElement {
  const nodes = data.nodes ?? []
  const edges = data.edges ?? []
  if (nodes.length === 0) return <DiagramError kind={kind} source="" message="No nodes" />

  const idIndex = new Map(nodes.map((n, i) => [n.id, i]))
  const inDeg = new Map<string, number>()
  nodes.forEach((n) => inDeg.set(n.id, 0))
  edges.forEach((e) => { if (idIndex.has(e.to)) inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1) })

  const layer = new Map<string, number>()
  const queue: string[] = nodes.filter((n) => (inDeg.get(n.id) ?? 0) === 0).map((n) => n.id)
  queue.forEach((id) => layer.set(id, 0))
  for (let head = 0; head < queue.length && head < 1000; head++) {
    const cur = queue[head]
    const lvl = layer.get(cur) ?? 0
    for (const e of edges) {
      if (e.from !== cur || !idIndex.has(e.to)) continue
      const next = lvl + 1
      if (!layer.has(e.to) || (layer.get(e.to) ?? 0) < next) {
        layer.set(e.to, next); queue.push(e.to)
      }
    }
  }
  nodes.forEach((n) => { if (!layer.has(n.id)) layer.set(n.id, 0) })

  const layers = new Map<number, RelNode[]>()
  nodes.forEach((n) => {
    const l = layer.get(n.id) ?? 0
    const arr = layers.get(l) ?? []
    arr.push(n); layers.set(l, arr)
  })
  const sortedLayers = [...layers.entries()].sort(([a], [b]) => a - b)

  const BOX_W = 170, BOX_H = 56, COL_GAP = 150, ROW_GAP = 22
  const colCount = sortedLayers.length
  const maxRows = Math.max(...sortedLayers.map(([, ns]) => ns.length), 1)

  // ── Parallel edge bookkeeping ──────────────────────────────────
  // Group edges that connect the same pair of nodes (regardless of direction).
  // We fan them out symmetrically so they stop overlapping. The outermost edge
  // in a group must arc clearly outside the box vertical range so neither the
  // line nor its label intrudes on the boxes themselves.
  const edgeGroups = new Map<string, number[]>()
  edges.forEach((e, i) => {
    const key = e.from < e.to ? `${e.from}\u0001${e.to}` : `${e.to}\u0001${e.from}`
    const arr = edgeGroups.get(key) ?? []
    arr.push(i)
    edgeGroups.set(key, arr)
  })
  const indexInGroup = new Map<number, { idx: number; total: number }>()
  edgeGroups.forEach((arr) => arr.forEach((edgeIdx, idx) => indexInGroup.set(edgeIdx, { idx, total: arr.length })))
  const maxParallel = Math.max(1, ...[...edgeGroups.values()].map((a) => a.length))

  // Per-edge offset (control-point Δy). We require the *outermost* curve to
  // arc at least BOX_H/2 + 16 px from the row centreline so it clears the box.
  const minOuterOffset = BOX_H / 2 + 16
  const edgeOffset = (idx: number, total: number): number => {
    if (total === 1) return 0
    const half = (total - 1) / 2
    const step = minOuterOffset / half
    return (idx - half) * step
  }

  // Reserve vertical headroom for the curves above/below each row.
  const verticalPad = maxParallel > 1 ? minOuterOffset + 18 : 14
  const svgW = colCount * BOX_W + (colCount - 1) * COL_GAP + 20
  const svgH = maxRows * BOX_H + (maxRows - 1) * ROW_GAP + verticalPad * 2

  const pos = new Map<string, { x: number; y: number }>()
  sortedLayers.forEach(([, ns], colIdx) => {
    const colX = 10 + colIdx * (BOX_W + COL_GAP)
    const blockH = ns.length * BOX_H + (ns.length - 1) * ROW_GAP
    const startY = (svgH - blockH) / 2
    ns.forEach((n, rowIdx) => pos.set(n.id, { x: colX, y: startY + rowIdx * (BOX_H + ROW_GAP) }))
  })

  return (
    <div className="rounded-lg overflow-hidden border border-border-subtle">
      {(data.title || data.subtitle) && (
        <div className="px-3 pt-2 pb-1.5 border-b border-border-subtle flex items-baseline gap-2 flex-wrap">
          {data.title && <div className="text-sm font-semibold text-text">{data.title}</div>}
          {data.subtitle && <div className="text-[11px] text-text-muted">{data.subtitle}</div>}
          <div className="ml-auto text-[10px] text-text-muted font-mono uppercase tracking-wide">{kind}</div>
        </div>
      )}
      <div className="p-3 overflow-x-auto flex justify-center">
        <svg width={svgW} height={svgH} className="font-mono block mx-auto" style={{ minWidth: svgW, maxWidth: "100%" }}>
          <defs>
            <marker id="rel-arrow" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto">
              <path d="M0,0 L0,6 L8,3 z" fill="rgba(96,165,250,0.95)" />
            </marker>
          </defs>

          {edges.map((e, i) => {
            const a = pos.get(e.from); const b = pos.get(e.to)
            if (!a || !b) return null
            const sx = a.x + BOX_W, sy = a.y + BOX_H / 2
            const ex = b.x,         ey = b.y + BOX_H / 2
            const { idx, total } = indexInGroup.get(i) ?? { idx: 0, total: 1 }
            const offset = edgeOffset(idx, total)

            const mx = (sx + ex) / 2
            const baseY = (sy + ey) / 2
            void baseY // retained for potential future use
            const path = `M ${sx} ${sy} C ${mx} ${sy + offset}, ${mx} ${ey + offset}, ${ex} ${ey}`
            return (
              <g key={`e${i}`}>
                {e.label && <title>{e.label}</title>}
                {/* Invisible wider hit target so the tooltip triggers easily */}
                <path d={path} fill="none" stroke="transparent" strokeWidth={12} style={{ cursor: "default" }} />
                <path d={path} fill="none" stroke="rgba(96,165,250,0.65)" strokeWidth={1.5} markerEnd="url(#rel-arrow)" style={{ pointerEvents: "none" }} />
              </g>
            )
          })}

          {nodes.map((n) => {
            const p = pos.get(n.id); if (!p) return null
            const label = n.label ?? n.id
            const tooltipParts = [label]
            if (n.subtitle) tooltipParts.push(n.subtitle)
            return (
              <g key={n.id} style={{ cursor: "default" }}>
                <title>{tooltipParts.join(" — ")}</title>
                <rect x={p.x} y={p.y} width={BOX_W} height={BOX_H} rx={6}
                  fill="rgba(123,111,199,0.10)" stroke="rgba(123,111,199,0.45)" strokeWidth={1} />
                <text x={p.x + BOX_W / 2} y={p.y + (n.subtitle ? 18 : 28)} textAnchor="middle"
                  fontSize={11} fill="var(--color-text)" fontWeight="600">
                  {truncate(label, 22)}
                </text>
                {n.subtitle && (
                  <text x={p.x + BOX_W / 2} y={p.y + 34} textAnchor="middle" fontSize={9} fill="rgba(148,163,184,0.85)">
                    {truncate(n.subtitle, 26)}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}

function truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n - 1) + "…" : s }
