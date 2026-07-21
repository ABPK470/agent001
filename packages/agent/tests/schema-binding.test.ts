import { describe, expect, it } from "vitest"
import { CatalogGraph } from "../src/tools/catalog/graph/index.js"
import type { CatalogColumn, CatalogTable } from "../src/tools/catalog/types.js"
import {
  detectBareInventedColumns,
  detectPostUnionGroupBy,
  detectUnverifiedTableRefs,
  extractBaseTableRefs,
  extractCteOutputColumns,
  outputNameFromSelectItem,
  parseCteChain
} from "../src/tools/database/mssql/schema-binding.js"
import { validateQueryDetailed } from "../src/tools/database/mssql/validation.js"

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
    expect(missing).toEqual(["dim.Client"])
  })

  it("accepts verified dim.Product when SQL uses dim.product casing", () => {
    const cat2 = buildGraph([
      table("dim", "Product", ["pk", "Name"]),
      table("publish", "Revenue", ["pk"])
    ])
    const accessor2 = () => cat2
    const verified = new Set(["dim.product", "publish.revenue"])
    const missing = detectUnverifiedTableRefs(
      "SELECT p.Name FROM dim.Product p JOIN publish.Revenue r ON r.pk = p.pk",
      verified,
      accessor2
    )
    expect(missing).toEqual([])
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

describe("CTE column parsing", () => {
  it("extracts explicit and implicit SELECT output names", () => {
    expect(outputNameFromSelectItem("SUM(r.RevenueZARMTD) AS TotalRevenue")).toBe("TotalRevenue")
    expect(outputNameFromSelectItem("r.pkClient")).toBe("pkClient")
    expect(outputNameFromSelectItem("c.ClientName")).toBe("ClientName")
  })

  it("parses chained CTE definitions and their projections", () => {
    const sql = `WITH base AS (
  SELECT r.pkClient, SUM(r.RevenueZARMTD) AS rev
  FROM publish.Revenue r
  GROUP BY r.pkClient
),
ranked AS (
  SELECT b.pkClient, b.rev, ROW_NUMBER() OVER (ORDER BY b.rev DESC) AS rn
  FROM base b
)
SELECT ranked.rev FROM ranked`
    const chain = parseCteChain(sql)
    expect(chain?.ctes.map((c) => c.name)).toEqual(["base", "ranked"])
    expect([...extractCteOutputColumns(chain!.ctes[0]!.body)]).toEqual(["pkclient", "rev"])
    expect([...extractCteOutputColumns(chain!.ctes[1]!.body)]).toEqual(["pkclient", "rev", "rn"])
  })
})

describe("validateQueryDetailed — schema binding", () => {
  const cat = buildGraph([
    table("publish", "Revenue", ["pkClient", "RevenueZARMTD"]),
    table("dim", "Client", ["pkClient", "ClientName"])
  ])

  it("blocks query_mssql when a joined table was not verified", () => {
    const verified = new Set(["publish.revenue"])
    const v = validateQueryDetailed("SELECT c.ClientName FROM publish.Revenue r JOIN dim.Client c ON c.pkClient = r.pkClient",
      { accessor: () => cat, verifiedTables: verified }
    )
    expect(v.ok).toBe(false)
    expect(v.code).toBe("unverified_table_reference")
  })

  it("does not treat CTE/table qualifiers as bare invented columns", () => {
    const aliasMap = new Map([["r", { alias: "r", qualifiedTable: "publish.Revenue" }]])
    const offenders = detectBareInventedColumns(
      "SELECT r.pkClient FROM publish.Revenue r JOIN agg ON r.pkClient = agg.pkClient WHERE agg.TotalRevenue > 0",
      aliasMap,
      (q) => (q === "publish.Revenue" ? { columns: [{ name: "pkClient" }] } : null),
      { allowedBareColumns: new Set(["totalrevenue"]) }
    )
    expect(offenders.some((o) => o.column === "agg")).toBe(false)
  })

  it("does not scan nested subquery identifiers against outer FROM tables", () => {
    const aliasMap = new Map([
      ["rm", { alias: "rm", qualifiedTable: "ai.RevenueMart" }],
      ["c", { alias: "c", qualifiedTable: "publish.Client" }],
    ])
    const offenders = detectBareInventedColumns(
      [
        "SELECT rm.pkClient FROM ai.RevenueMart rm",
        "JOIN publish.Client c ON c.ClientKey = rm.ClientKey",
        "WHERE EXISTS (",
        "  SELECT 1 FROM dim.Officer o WHERE o.BankerName = c.ClientName",
        ")",
      ].join("\n"),
      aliasMap,
      (q) => {
        if (q === "ai.RevenueMart") return { columns: [{ name: "pkClient" }, { name: "ClientKey" }] }
        if (q === "publish.Client") return { columns: [{ name: "ClientKey" }, { name: "ClientName" }] }
        return null
      },
    )
    expect(offenders.some((o) => o.column === "BankerName")).toBe(false)
  })

  it("still flags bare invented tokens in top-level WHERE", () => {
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

  it("extracts CTE output names even when SELECT list contains a nested FROM", () => {
    const cols = extractCteOutputColumns(`
      SELECT
        r.pkClient,
        (SELECT TOP 1 x.v FROM #t x) AS NestedVal,
        SUM(r.RevenueZARMTD) AS TotalRevenueMTD
      FROM publish.Revenue r
      GROUP BY r.pkClient
    `)
    expect(cols.has("totalrevenuemtd")).toBe(true)
    expect(cols.has("nestedval")).toBe(true)
    expect(cols.has("pkclient")).toBe(true)
  })
})
