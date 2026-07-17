import { describe, expect, it } from "vitest"

import { SyncPlanChangeType } from "../../domain/enums.js"
import { buildDependencyGraph } from "./diff-table.js"

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
    scopePredicate: "1=1",
    stats: { unchanged: 0, lowConfidence: 0 },
    changeSet,
    samples: { insert: [], update: [], delete: [] },
    conflicts: [],
    warnings: [],
    diffDurationMs: 1
  }
}

describe("buildDependencyGraph", () => {
  const tables = [
    { name: "core.Contract" },
    { name: "core.Pipeline" },
    { name: "core.Activity" }
  ] as const

  it("maps table movement to graph node status", () => {
    const results = [
      mockTableResult("core.Contract", { update: 2 }),
      mockTableResult("core.Pipeline", { insert: 1 }),
      mockTableResult("core.Activity", {})
    ]
    const graph = buildDependencyGraph("core.Contract", tables, results)
    expect(graph.nodes.find((n) => n.id === "core.Contract")?.status).toBe(SyncPlanChangeType.Updates)
    expect(graph.nodes.find((n) => n.id === "core.Pipeline")?.status).toBe(SyncPlanChangeType.Inserts)
    expect(graph.nodes.find((n) => n.id === "core.Activity")?.status).toBe(SyncPlanChangeType.Unchanged)
  })

  it("fans edges from root to children", () => {
    const results = [mockTableResult("core.Pipeline", { delete: 1 })]
    const graph = buildDependencyGraph("core.Contract", [tables[1]!], results)
    expect(graph.edges).toEqual([{ from: "core.Contract", to: "core.Pipeline" }])
    expect(graph.nodes[0]?.status).toBe(SyncPlanChangeType.Deletes)
  })

  it("handles empty results", () => {
    const graph = buildDependencyGraph("core.Contract", tables, [])
    expect(graph.nodes).toHaveLength(3)
    expect(graph.edges).toHaveLength(2)
  })
})
