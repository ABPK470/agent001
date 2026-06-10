/**
 * Canonical dashboard payload for sync preview answers.
 *
 * Built from the persisted SyncPlan so chat UIs render KPI + dependency
 * graph even when the model paraphrases or mis-shapes the fenced block.
 */

import type { SyncPlan } from "./plan-store.js"

export interface ChatDashboardItem {
  kind: string
  width?: number
  spec: Record<string, unknown>
}

export interface ChatDashboardPayload {
  title?: string
  subtitle?: string
  items: ChatDashboardItem[]
}

export function buildSyncPreviewDashboard(plan: SyncPlan): ChatDashboardPayload {
  const totals = plan.totals
  const items: ChatDashboardItem[] = [
    {
      kind: "kpi",
      width: 12,
      spec: {
        cards: [
          { label: "Inserts", value: totals.insert, valueFormat: "compact" },
          { label: "Updates", value: totals.update, valueFormat: "compact" },
          { label: "Deletes", value: totals.delete, valueFormat: "compact" },
          { label: "Unchanged", value: totals.unchanged, valueFormat: "compact" },
          { label: "Tables", value: totals.tablesCount, valueFormat: "compact" },
          ...(totals.conflicts > 0
            ? [{ label: "Conflicts", value: totals.conflicts, valueFormat: "compact" }]
            : [])
        ]
      }
    }
  ]

  const graph = plan.dependencyGraph
  if (graph.nodes.length > 0) {
    items.push({
      kind: "relationships",
      width: 12,
      spec: {
        title: "Table dependency graph",
        nodes: graph.nodes.map((n) => ({
          id: n.id,
          label: n.label,
          subtitle: `+${n.counts.insert} ~${n.counts.update} -${n.counts.delete}`
        })),
        edges: graph.edges
      }
    })
  }

  const changedTables = plan.tables.filter(
    (t) => t.counts.insert + t.counts.update + t.counts.delete + t.counts.conflicts > 0
  )
  if (changedTables.length >= 3) {
    items.push({
      kind: "bar",
      width: 12,
      spec: {
        title: "Changes by table",
        orientation: "horizontal",
        categories: changedTables.map((t) => t.table),
        series: [
          { name: "Inserts", values: changedTables.map((t) => t.counts.insert) },
          { name: "Updates", values: changedTables.map((t) => t.counts.update) },
          { name: "Deletes", values: changedTables.map((t) => t.counts.delete) }
        ]
      }
    })
  }

  const entityLabel = plan.entity.displayName ?? String(plan.entity.id)
  return {
    title: `Preview — ${entityLabel}`,
    subtitle: `${plan.source} → ${plan.target}`,
    items
  }
}

export function formatSyncPreviewDashboardFence(plan: SyncPlan): string {
  const payload = buildSyncPreviewDashboard(plan)
  return ["```dashboard", JSON.stringify(payload, null, 2), "```"].join("\n")
}
