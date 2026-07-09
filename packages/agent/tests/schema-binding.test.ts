import { describe, expect, it } from "vitest"
import { CatalogGraph } from "../src/tools/catalog/graph/index.js"
import type { CatalogColumn, CatalogTable } from "../src/tools/catalog/types.js"
import {
  detectBareInventedColumns,
  detectPostUnionGroupBy,
  detectUnverifiedTableRefs,
  extractBaseTableRefs
} from "../src/tools/mssql/schema-binding.js"
import { validateQueryDetailed } from "../src/tools/mssql/validation.js"

function col(name: string): CatalogColumn {
  return { name, dataType: "int", maxLength: null, nullable: false, isPK: false }
}

function table(schema: string, name: string, columns: string[]): CatalogTable {
  return {
    schema,
    name,
    qualifiedName: `${schema}.${name}`,
    type: "TABLE",
    rowCount: 1000,
    columns: columns.map(col),
    fkOutgoing: [],
    fkIncoming: []
  }
}

function buildGraph(tables: CatalogTable[]): CatalogGraph {
  return CatalogGraph.fromSnapshot({
    version: 7,
    builtAt: new Date().toISOString(),
    source: "test",
    tables,
    implicitEdges: [],
    viewSourceRows: [],
    sysCatalog: []
  } as Parameters<typeof CatalogGraph.fromSnapshot>[0])
}

describe("extractBaseTableRefs", () => {
  it("collects schema-qualified FROM/JOIN tables", () => {
    const refs = extractBaseTableRefs(
      "SELECT * FROM publish.Revenue r JOIN dim.Client c ON c.pk = r.pk JOIN dim.Date d ON d.pk = r.pk"
    )
    expect(refs.sort()).toEqual(["dim.client", "dim.date", "publish.revenue"])
  })
})

describe("detectUnverifiedTableRefs", () => {
  const cat = buildGraph([
    table("publish", "Revenue", ["pkClient", "RevenueZARMTD"]),
    table("dim", "Client", ["pkClient", "ClientName"]),
    table("dim", "Date", ["pkDate", "Year"])
  ])
  const accessor = () => cat

  it("lists catalog tables not in the verified set", () => {
    const verified = new Set(["publish.revenue", "dim.date"])
    const missing = detectUnverifiedTableRefs(
      "SELECT c.ClientName FROM publish.Revenue r JOIN dim.Client c ON c.pkClient = r.pkClient JOIN dim.Date d ON d.pkDate = r.pkMonth",
      verified,
      accessor
    )
    expect(missing).toEqual(["dim.client"])
  })
})

describe("detectPostUnionGroupBy", () => {
  it("detects GROUP BY only on the last UNION branch", () => {
    expect(
      detectPostUnionGroupBy("SELECT a FROM t1 UNION ALL SELECT b FROM t2 GROUP BY b")
    ).toBe(true)
  })

  it("allows GROUP BY inside each UNION branch", () => {
    expect(
      detectPostUnionGroupBy(
        "SELECT a, SUM(x) FROM t1 GROUP BY a UNION ALL SELECT a, SUM(y) FROM t2 GROUP BY a"
      )
    ).toBe(false)
  })
})

describe("validateQueryDetailed — schema binding", () => {
  const cat = buildGraph([
    table("publish", "Revenue", ["pkClient", "RevenueZARMTD"]),
    table("dim", "Client", ["pkClient", "ClientName"])
  ])

  it("blocks query_mssql when a joined table was not verified", () => {
    const verified = new Set(["publish.revenue"])
    const v = validateQueryDetailed(
      "SELECT c.ClientName FROM publish.Revenue r JOIN dim.Client c ON c.pkClient = r.pkClient",
      false,
      { accessor: () => cat, verifiedTables: verified }
    )
    expect(v.ok).toBe(false)
    expect(v.code).toBe("unverified_table_reference")
  })

  it("flags bare invented tokens in WHERE", () => {
    const cat = buildGraph([
      table("publish", "Revenue", ["pkClient", "RevenueZARMTD"]),
      table("dim", "Client", ["pkClient", "ClientName"])
    ])
    const aliasMap = new Map([
      ["r", { alias: "r", qualifiedTable: "publish.Revenue" }],
      ["c", { alias: "c", qualifiedTable: "dim.Client" }]
    ])
    const offenders = detectBareInventedColumns(
      "SELECT c.ClientName FROM publish.Revenue r JOIN dim.Client c ON c.pkClient = r.pkClient WHERE Name = 'x'",
      aliasMap,
      (q) => cat.getTable(q)
    )
    expect(offenders.some((o) => o.column === "Name")).toBe(true)
  })
})
