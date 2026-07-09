import { describe, expect, it } from "vitest"
import { searchCatalog } from "../src/tools/catalog/search.js"
import { CatalogGraph } from "../src/tools/catalog/graph/index.js"
import type { CatalogColumn, CatalogTable } from "../src/tools/catalog/types.js"

function col(name: string): CatalogColumn {
  return { name, dataType: "int", maxLength: null, nullable: false, isPK: false }
}

function table(schema: string, name: string, rowCount: number): CatalogTable {
  return {
    schema,
    name,
    qualifiedName: `${schema}.${name}`,
    type: "TABLE",
    rowCount,
    columns: [col("Id")],
    fkOutgoing: [],
    fkIncoming: []
  }
}

function graphFrom(tables: CatalogTable[]): {
  graph: CatalogGraph
  nameIndex: Map<string, Set<string>>
  columnIndex: Map<string, Set<string>>
} {
  const g = CatalogGraph.fromSnapshot({
    version: 7,
    builtAt: new Date().toISOString(),
    source: "test",
    tables,
    implicitEdges: [],
    viewSourceRows: [],
    sysCatalog: []
  } as Parameters<typeof CatalogGraph.fromSnapshot>[0])
  return { graph: g, nameIndex: g.nameIndex, columnIndex: g.columnIndex }
}

describe("searchCatalog schemaFilter", () => {
  it("ranks only within the requested schema", () => {
    const tables = [
      table("publish", "Revenue", 99_000_000),
      table("publish", "RevenueRules", 9_000_000),
      table("ai", "RevenueMart", 500_000)
    ]
    const { graph, nameIndex, columnIndex } = graphFrom(tables)
    const hits = searchCatalog(
      graph.tables,
      nameIndex,
      columnIndex,
      graph.implicitJoinIndex,
      "revenue",
      5,
      { schemaFilter: "ai" }
    )
    expect(hits).toHaveLength(1)
    expect(hits[0]!.table.qualifiedName).toBe("ai.RevenueMart")
  })
})
