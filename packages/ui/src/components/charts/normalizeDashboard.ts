/**
 * Normalize agent-emitted dashboard JSON into the renderer contract.
 *
 * Models often flatten KPI cards or relationship graphs at the top level
 * instead of the `items[{ kind, width, spec }]` grid the chart catalogue
 * specifies. All chat surfaces share this normalizer via Dashboard.tsx.
 */

import type { DashboardData, DashboardItem } from "./Dashboard"

const KPI_KINDS = new Set(["kpi"])
const REL_KINDS = new Set(["relationships", "flow"])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function normalizeItem(raw: unknown): DashboardItem | null {
  const o = asRecord(raw)
  if (!o) return null
  const kindRaw = asString(o.kind) ?? asString(o.type)
  if (!kindRaw) return null
  const width = typeof o.width === "number" ? Math.max(1, Math.min(12, o.width)) : 12

  if (o.spec != null) {
    return { kind: kindRaw as DashboardItem["kind"], width, spec: o.spec }
  }

  if (KPI_KINDS.has(kindRaw) && Array.isArray(o.cards)) {
    return { kind: "kpi", width, spec: o }
  }
  if (REL_KINDS.has(kindRaw) && Array.isArray(o.nodes)) {
    return { kind: kindRaw as "relationships" | "flow", width, spec: o }
  }

  const { kind: _k, type: _t, width: _w, ...rest } = o
  if (Object.keys(rest).length === 0) return null
  return { kind: kindRaw as DashboardItem["kind"], width, spec: rest }
}

function cardsFromSyncTotals(r: Record<string, unknown>): Array<{ label: string; value: number }> {
  const pairs: Array<[string, string[]]> = [
    ["Inserts", ["insert", "inserts"]],
    ["Updates", ["update", "updates"]],
    ["Deletes", ["delete", "deletes"]],
    ["Unchanged", ["unchanged"]],
    ["Tables", ["tables", "tablesCount", "tableCount"]]
  ]
  const cards: Array<{ label: string; value: number }> = []
  for (const [label, keys] of pairs) {
    for (const key of keys) {
      const v = r[key]
      if (typeof v === "number" && Number.isFinite(v)) {
        cards.push({ label, value: v })
        break
      }
    }
  }
  return cards
}

function relationshipsFromRecord(r: Record<string, unknown>): Record<string, unknown> | null {
  if (Array.isArray(r.nodes)) {
    return {
      title: asString(r.title) ?? asString(r.graphTitle),
      subtitle: asString(r.subtitle),
      nodes: r.nodes,
      edges: r.edges ?? []
    }
  }
  const nested = asRecord(r.relationships) ?? asRecord(r.graph) ?? asRecord(r.flow)
  if (nested && Array.isArray(nested.nodes)) return nested
  return null
}

export function normalizeDashboardData(raw: unknown): DashboardData {
  const r = asRecord(raw)
  if (!r) return { items: [] }

  const title = asString(r.title)
  const subtitle = asString(r.subtitle)
  const items: DashboardItem[] = []

  if (Array.isArray(r.items)) {
    for (const entry of r.items) {
      const item = normalizeItem(entry)
      if (item) items.push(item)
    }
  }

  const topCards = r.cards ?? r.kpis
  if (Array.isArray(topCards) && topCards.length > 0 && !items.some((i) => i.kind === "kpi")) {
    items.unshift({
      kind: "kpi",
      width: 12,
      spec: { cards: topCards, title: asString(r.kpiTitle) }
    })
  }

  const syncCards = cardsFromSyncTotals(r)
  if (syncCards.length > 0 && !items.some((i) => i.kind === "kpi")) {
    items.unshift({ kind: "kpi", width: 12, spec: { cards: syncCards } })
  }

  const rel = relationshipsFromRecord(r)
  if (rel && !items.some((i) => i.kind === "relationships" || i.kind === "flow")) {
    items.push({ kind: "relationships", width: 12, spec: rel })
  }

  return { ...(title ? { title } : {}), ...(subtitle ? { subtitle } : {}), items }
}
