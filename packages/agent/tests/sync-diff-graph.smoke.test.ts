/**
 * Smoke tests for sync `buildDependencyGraph`.
 *
 * Pure transform: locks the node/edge layout produced for a definition's
 * tables + per-table results. Avoids hitting any real database.
 */

import type { AuthoredSyncDefinitionTable } from "@mia/shared-types"
import type { SyncPlanTable } from "@mia/sync"
import { buildDependencyGraph } from "@mia/sync"
import { describe, expect, it } from "vitest"

describe("buildDependencyGraph smoke", () => {
  const rootTable = "dim.Client"
  const tables: AuthoredSyncDefinitionTable[] = [
    { name: "dim.Client", scopeColumn: "ClientId", predicate: "ClientId = {id}" } as AuthoredSyncDefinitionTable,
    { name: "fact.Account", scopeColumn: "AccountId", predicate: "ClientId = {id}" } as AuthoredSyncDefinitionTable,
    { name: "fact.Transaction", scopeColumn: "TxnId", predicate: "ClientId = {id}" } as AuthoredSyncDefinitionTable
  ]

  function tbl(
    name: string,
    movement: { insert?: number; update?: number; delete?: number },
    unchanged = 0
  ): SyncPlanTable {
    const insert = movement.insert ?? 0
    const update = movement.update ?? 0
    const del = movement.delete ?? 0
    return {
      table: name,
      scopePredicate: "x",
      stats: { unchanged, lowConfidence: 0 },
      changeSet: {
        insert: Array.from({ length: insert }, (_, i) => ({ pk: `${i}`, values: { id: i } })),
        update: Array.from({ length: update }, (_, i) => ({ pk: `u${i}`, values: { id: i } })),
        delete: Array.from({ length: del }, (_, i) => ({ pk: `d${i}`, values: { id: i } }))
      },
      samples: { insert: [], update: [], delete: [] },
      conflicts: [],
      warnings: [],
      diffDurationMs: 0
    } as SyncPlanTable
  }

  it("marks the root green when nothing changes", () => {
    const graph = buildDependencyGraph(rootTable, tables, [
      tbl("dim.Client", {}, 1),
      tbl("fact.Account", {}, 5),
      tbl("fact.Transaction", {}, 12)
    ])
    expect(graph.nodes).toHaveLength(3)
    expect(graph.nodes.every((n) => n.status === "unchanged")).toBe(true)
    expect(graph.edges).toEqual([
      { from: "dim.Client", to: "fact.Account" },
      { from: "dim.Client", to: "fact.Transaction" }
    ])
  })

  it("uses the most-destructive status (deletes wins over updates and inserts)", () => {
    const graph = buildDependencyGraph(rootTable, tables, [
      tbl("dim.Client", { update: 1 }),
      tbl("fact.Account", { insert: 3, delete: 2 }),
      tbl("fact.Transaction", { insert: 1 })
    ])
    const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n]))
    expect(byId["dim.Client"]?.status).toBe("updates")
    expect(byId["fact.Account"]?.status).toBe("deletes")
    expect(byId["fact.Transaction"]?.status).toBe("inserts")
  })

  it("uses the trailing schema-qualified label as node label", () => {
    const graph = buildDependencyGraph(rootTable, tables, [
      tbl("dim.Client", {}),
      tbl("fact.Account", {}),
      tbl("fact.Transaction", {})
    ])
    expect(graph.nodes.map((n) => n.label)).toEqual(["Client", "Account", "Transaction"])
  })
})
