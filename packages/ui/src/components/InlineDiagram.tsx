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
    <div className="rounded-lg overflow-hidden border border-white/[0.08]">
      <div className="px-3 py-1 bg-white/[0.04] text-[11px] text-error font-mono border-b border-white/[0.06]">
        {kind} (parse error: {message})
      </div>
      <pre className="px-3 py-2.5 text-[12px] font-mono text-text-secondary overflow-x-auto bg-base">{source}</pre>
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

  const BOX_W = 150, BOX_H = 48, COL_GAP = 80, ROW_GAP = 14
  const colCount = sortedLayers.length
  const maxRows = Math.max(...sortedLayers.map(([, ns]) => ns.length), 1)
  const svgW = colCount * BOX_W + (colCount - 1) * COL_GAP + 20
  const svgH = maxRows * BOX_H + (maxRows - 1) * ROW_GAP + 20

  const pos = new Map<string, { x: number; y: number }>()
  sortedLayers.forEach(([, ns], colIdx) => {
    const colX = 10 + colIdx * (BOX_W + COL_GAP)
    const blockH = ns.length * BOX_H + (ns.length - 1) * ROW_GAP
    const startY = (svgH - blockH) / 2
    ns.forEach((n, rowIdx) => pos.set(n.id, { x: colX, y: startY + rowIdx * (BOX_H + ROW_GAP) }))
  })

  return (
    <div className="rounded-lg overflow-hidden border border-white/[0.08] bg-base">
      {(data.title || data.subtitle) && (
        <div className="px-3 pt-2 pb-1.5 border-b border-white/[0.06] flex items-baseline gap-2 flex-wrap">
          {data.title && <div className="text-sm font-semibold text-text">{data.title}</div>}
          {data.subtitle && <div className="text-[11px] text-text-muted">{data.subtitle}</div>}
          <div className="ml-auto text-[10px] text-text-muted font-mono uppercase tracking-wide">{kind}</div>
        </div>
      )}
      <div className="p-3 overflow-x-auto">
        <svg width={svgW} height={svgH} className="font-mono" style={{ minWidth: svgW, maxWidth: "100%" }}>
          <defs>
            <marker id="rel-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
              <path d="M0,0 L0,6 L8,3 z" fill="rgba(96,165,250,0.85)" />
            </marker>
          </defs>

          {edges.map((e, i) => {
            const a = pos.get(e.from); const b = pos.get(e.to)
            if (!a || !b) return null
            const sx = a.x + BOX_W, sy = a.y + BOX_H / 2
            const ex = b.x,         ey = b.y + BOX_H / 2
            const mx = (sx + ex) / 2
            const path = `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ey}, ${ex} ${ey}`
            return (
              <g key={`e${i}`}>
                <path d={path} fill="none" stroke="rgba(96,165,250,0.6)" strokeWidth={1.5} markerEnd="url(#rel-arrow)" />
                {e.label && (
                  <text x={mx} y={(sy + ey) / 2 - 4} textAnchor="middle" fontSize={9} fill="rgba(148,163,184,0.85)">
                    {e.label}
                  </text>
                )}
              </g>
            )
          })}

          {nodes.map((n) => {
            const p = pos.get(n.id); if (!p) return null
            return (
              <g key={n.id}>
                <rect x={p.x} y={p.y} width={BOX_W} height={BOX_H} rx={6}
                  fill="rgba(123,111,199,0.10)" stroke="rgba(123,111,199,0.45)" strokeWidth={1} />
                <text x={p.x + BOX_W / 2} y={p.y + (n.subtitle ? 18 : 28)} textAnchor="middle"
                  fontSize={11} fill="#f4f4f5" fontWeight="600">
                  {truncate(n.label ?? n.id, 22)}
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
