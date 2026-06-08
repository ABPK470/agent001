/**
 * CatalogGraph.schemaFingerprint() — Phase 5 plumbing.
 *
 * Asserts the fingerprint is:
 *   - stable across rebuilds with the same shape
 *   - independent of build order
 *   - sensitive to column additions/renames
 *   - sensitive to new tables
 *   - independent of row counts (rowCount is run-state, not shape)
 */
import { describe, expect, it } from "vitest"
import { CatalogGraph } from "../src/tools/catalog/graph/index.js"
import type { CatalogColumn, CatalogTable } from "../src/tools/catalog/types.js"

function col(name: string, dataType = "int"): CatalogColumn {
  return { name, dataType, nullable: false } as CatalogColumn
}
function table(schema: string, name: string, columns: string[], rowCount: number | null = 0): CatalogTable {
  return {
    schema,
    name,
    qualifiedName: `${schema}.${name}`,
    type: "TABLE",
    rowCount,
    columns: columns.map((c) => col(c)),
    fkOutgoing: [],
    fkIncoming: []
  }
}

function buildGraph(tables: CatalogTable[]): CatalogGraph {
  const tableMap = new Map(tables.map((t) => [t.qualifiedName.toLowerCase(), t]))
  return CatalogGraph.fromSnapshot({
    version: 6,
    builtAt: new Date().toISOString(),
    source: "test",
    tables,
    implicitEdges: [],
    lineage: [],
    viewSourceRows: [],
    sysCatalog: []
  } as Parameters<typeof CatalogGraph.fromSnapshot>[0])
}

describe("CatalogGraph.schemaFingerprint", () => {
  const tables = [
    table("dbo", "Client", ["pkClient", "name", "createdAt"]),
    table("publish", "Revenue", ["pkClient", "amount", "fy"])
  ]

  it("returns a stable sha1-prefixed string", () => {
    const fp = buildGraph(tables).schemaFingerprint()
    expect(fp).toMatch(/^sha1:[0-9a-f]{16}$/)
  })

  it("is deterministic for the same shape regardless of insertion order", () => {
    const a = buildGraph([tables[0]!, tables[1]!]).schemaFingerprint()
    const b = buildGraph([tables[1]!, tables[0]!]).schemaFingerprint()
    expect(a).toBe(b)
  })

  it("ignores rowCount changes", () => {
    const a = buildGraph(tables).schemaFingerprint()
    const withRows = tables.map((t) => ({ ...t, rowCount: 1_000_000 }))
    const b = buildGraph(withRows).schemaFingerprint()
    expect(a).toBe(b)
  })

  it("changes when a column is added", () => {
    const a = buildGraph(tables).schemaFingerprint()
    const extended = [tables[0]!, { ...tables[1]!, columns: [...tables[1]!.columns, col("newCol")] }]
    const b = buildGraph(extended).schemaFingerprint()
    expect(b).not.toBe(a)
  })

  it("changes when a new table is added", () => {
    const a = buildGraph(tables).schemaFingerprint()
    const b = buildGraph([...tables, table("dbo", "Other", ["pkOther"])]).schemaFingerprint()
    expect(b).not.toBe(a)
  })
})
