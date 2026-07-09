import { describe, expect, it } from "vitest"

import type { EntityRegistryTable } from "./index.js"
import { renumberEntityRegistryTables } from "./entity-registry-table-order.js"

function table(name: string, executionOrder: number): EntityRegistryTable {
  return {
    name,
    scope: { kind: "rootPk", column: "id" },
    executionOrder,
    scd2Override: null,
    verified: false,
    archiveTable: null,
    note: null,
    provenance: { kind: "manual" },
    scopeColumn: null,
    source: "manual",
    groundedByPipeline: null,
    enabledByDefault: true,
    userControllable: null,
  }
}

describe("renumberEntityRegistryTables", () => {
  it("assigns contiguous 1-based orders after sorting", () => {
    const renumbered = renumberEntityRegistryTables([
      table("gate.jsonSchema", 0),
      table("gate.MetaTable", 0),
      table("gate.MetaView", 2),
      table("gate.MetaColumn", 3),
    ])
    expect(renumbered.map((entry) => [entry.name, entry.executionOrder])).toEqual([
      ["gate.jsonSchema", 1],
      ["gate.MetaTable", 2],
      ["gate.MetaView", 3],
      ["gate.MetaColumn", 4],
    ])
  })
})
