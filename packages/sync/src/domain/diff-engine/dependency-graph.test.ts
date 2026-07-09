import { describe, expect, it } from "vitest"

import { SyncPlanChangeType } from "../enums.js"
import { buildDependencyGraph } from "./index.js"

function mockTableResult(table: string, movement: { insert?: number; update?: number; delete?: number }) {
  const changeSet = {
    insert: Array.from({ length: movement.insert ?? 0 }, (_, i) => ({
      pk: String(i + 1),
      values: { id: i + 1 }
    })),
    update: Array.from({ length: movement.update ?? 0 }, (_, i) => ({
      pk: String(i + 100),
      values: { id: i + 100 }
    })),
    delete: Array.from({ length: movement.delete ?? 0 }, (_, i) => ({
      pk: String(i + 200),
      values: { id: i + 200 }
    }))
  }
  return {
    table,
    scopePredicate: "x = 1",
    stats: { unchanged: 5, lowConfidence: 0 },
    changeSet,
    samples: { insert: [], update: [], delete: [] },
    conflicts: [],
    warnings: [],
    diffDurationMs: 3
  }
}

describe("buildDependencyGraph", () => {
  const tables = [
    { name: "core.Contract", scopeColumn: "contractId", predicate: "contractId = {id}" },
    { name: "core.Pipeline", scopeColumn: "contractId", predicate: "contractId = {id}" },
    { name: "core.Dataset", scopeColumn: "contractId", predicate: "contractId = {id}" }
  ]

  it("marks insert tables as Inserts status", () => {
    const results = [
      mockTableResult("core.Contract", {}),
      mockTableResult("core.Pipeline", { insert: 2 }),
      mockTableResult("core.Dataset", {})
    ]
    const graph = buildDependencyGraph("core.Contract", tables, results)
    const pipeline = graph.nodes.find((n) => n.id === "core.Pipeline")
    expect(pipeline?.status).toBe(SyncPlanChangeType.Inserts)
    expect(pipeline?.movement.insert).toBe(2)
  })

  it("prefers delete status over insert/update", () => {
    const results = [mockTableResult("core.Pipeline", { insert: 1, delete: 1 })]
    const graph = buildDependencyGraph("core.Contract", [tables[1]!], results)
    expect(graph.nodes[0]?.status).toBe(SyncPlanChangeType.Deletes)
  })

  it("fans edges from root to all child tables", () => {
    const results = tables.map((t) => mockTableResult(t.name, {}))
    const graph = buildDependencyGraph("core.Contract", tables, results)
    expect(graph.edges).toEqual([
      { from: "core.Contract", to: "core.Pipeline" },
      { from: "core.Contract", to: "core.Dataset" }
    ])
  })
})
