/**
 * Smoke tests for sync `buildDependencyGraph`.
 *
 * Pure transform: locks the node/edge layout produced for a recipe + per-table
 * results before the `sync/diff-engine` split (Phase 2). Avoids hitting any
 * real database — feeds in synthesized `SyncPlanTable[]` directly.
 */

import { describe, expect, it } from "vitest"
import { buildDependencyGraph } from "../../sync/src/index.js"
import type { SyncPlanTable, SyncRecipe } from "../../sync/src/index.js"

describe("buildDependencyGraph smoke", () => {
  const recipe: SyncRecipe = {
    entityType: "client" as never,
    rootTable: "dim.Client",
    tables: [
      { name: "dim.Client", role: "root", primaryKey: "ClientId" } as never,
      { name: "fact.Account", role: "child", primaryKey: "AccountId" } as never,
      { name: "fact.Transaction", role: "child", primaryKey: "TxnId" } as never,
    ],
  } as SyncRecipe

  function tbl(name: string, counts: Partial<SyncPlanTable["counts"]>): SyncPlanTable {
    return {
      table: name,
      counts: { insert: 0, update: 0, delete: 0, unchanged: 0, lowConfidence: 0, conflicts: 0, ...counts },
    } as SyncPlanTable
  }

  it("marks the root green when nothing changes", () => {
    const graph = buildDependencyGraph(recipe, [
      tbl("dim.Client", { unchanged: 1 }),
      tbl("fact.Account", { unchanged: 5 }),
      tbl("fact.Transaction", { unchanged: 12 }),
    ])
    expect(graph.nodes).toHaveLength(3)
    expect(graph.nodes.every((n) => n.status === "unchanged")).toBe(true)
    // Edges fan from root to every other table.
    expect(graph.edges).toEqual([
      { from: "dim.Client", to: "fact.Account" },
      { from: "dim.Client", to: "fact.Transaction" },
    ])
  })

  it("uses the most-destructive status (deletes wins over updates and inserts)", () => {
    const graph = buildDependencyGraph(recipe, [
      tbl("dim.Client", { update: 1 }),
      tbl("fact.Account", { insert: 3, delete: 2 }),
      tbl("fact.Transaction", { insert: 1 }),
    ])
    const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n]))
    expect(byId["dim.Client"]?.status).toBe("updates")
    expect(byId["fact.Account"]?.status).toBe("deletes")
    expect(byId["fact.Transaction"]?.status).toBe("inserts")
  })

  it("uses the trailing schema-qualified label as node label", () => {
    const graph = buildDependencyGraph(recipe, [
      tbl("dim.Client", {}),
      tbl("fact.Account", {}),
      tbl("fact.Transaction", {}),
    ])
    expect(graph.nodes.map((n) => n.label)).toEqual(["Client", "Account", "Transaction"])
  })
})
