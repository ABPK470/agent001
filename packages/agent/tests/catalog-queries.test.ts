/**
 * Catalog queries facade — Phase 0 primitives.
 *
 * Every test uses synthetic schema/table/column names that do NOT match any
 * customer's deployment. The whole point of the facade is to be name-agnostic,
 * so the fixtures must prove that.
 */
import { beforeEach, describe, expect, it } from "vitest"
import { CatalogGraph } from "../src/tools/catalog/graph/index.js"
import {
    _resetCatalogQueriesCache,
    calendarDimensionTable,
    dateGrainColumn,
    highCardinalityKeyColumns,
    isExpensiveUnionView,
    isLargeObject,
    isUnionView,
    listExpensiveUnionViews,
    listLargeObjects,
    listSchemas,
    persistedMirrorOf,
    primaryKeyColumns,
    topNTables,
    topNUnionViews,
    unionBranchCount,
} from "../src/tools/catalog/queries.js"
import type { CatalogColumn, CatalogFK, CatalogTable, ViewLineage } from "../src/tools/catalog/types.js"

function col(name: string, dataType = "int", isPK = false): CatalogColumn {
  return { name, dataType, maxLength: null, nullable: false, isPK }
}

function table(
  schema: string,
  name: string,
  opts: {
    type?: "TABLE" | "VIEW"
    columns?: CatalogColumn[]
    rowCount?: number | null
    viewDefinition?: string
    fkOutgoing?: CatalogFK[]
    fkIncoming?: CatalogFK[]
  } = {},
): CatalogTable {
  return {
    schema,
    name,
    qualifiedName: `${schema}.${name}`,
    type: opts.type ?? "TABLE",
    rowCount: opts.rowCount ?? null,
    columns: opts.columns ?? [],
    fkOutgoing: opts.fkOutgoing ?? [],
    fkIncoming: opts.fkIncoming ?? [],
    viewDefinition: opts.viewDefinition,
  }
}

function buildGraph(
  tables: CatalogTable[],
  opts: { viewSourceRows?: Array<{ name: string; sourceRows: number }>; lineage?: ViewLineage[] } = {},
): CatalogGraph {
  return CatalogGraph.fromSnapshot({
    version: 6,
    builtAt: new Date().toISOString(),
    source: "test",
    tables,
    implicitEdges: [],
    lineage: opts.lineage ?? [],
    viewSourceRows: opts.viewSourceRows ?? [],
    sysCatalog: [],
  } as Parameters<typeof CatalogGraph.fromSnapshot>[0])
}

beforeEach(() => _resetCatalogQueriesCache())

describe("isLargeObject", () => {
  it("returns false when no catalog is loaded (no silent fallback)", () => {
    expect(isLargeObject("anything.atall", { accessor: () => null })).toBe(false)
  })

  it("flags tables whose rowCount ≥ threshold", () => {
    const g = buildGraph([
      table("alpha", "bigFact", { rowCount: 50_000_000 }),
      table("alpha", "smallDim", { rowCount: 1_000 }),
    ])
    expect(isLargeObject("alpha.bigFact", { accessor: () => g })).toBe(true)
    expect(isLargeObject("alpha.smallDim", { accessor: () => g })).toBe(false)
  })

  it("flags VIEWs whose summed source rows ≥ threshold (via viewSourceRows)", () => {
    const g = buildGraph(
      [table("zeta", "MegaView", { type: "VIEW" })],
      { viewSourceRows: [{ name: "zeta.MegaView", sourceRows: 600_000_000 }] },
    )
    expect(isLargeObject("zeta.MegaView", { accessor: () => g })).toBe(true)
  })

  it("respects a custom threshold", () => {
    const g = buildGraph([table("a", "T", { rowCount: 5_000 })])
    expect(isLargeObject("a.T", { accessor: () => g, threshold: 1_000 })).toBe(true)
    expect(isLargeObject("a.T", { accessor: () => g, threshold: 10_000 })).toBe(false)
  })

  it("is case-insensitive", () => {
    const g = buildGraph([table("Alpha", "BigFact", { rowCount: 50_000_000 })])
    expect(isLargeObject("ALPHA.BIGFACT", { accessor: () => g })).toBe(true)
    expect(isLargeObject("alpha.bigfact", { accessor: () => g })).toBe(true)
  })

  it("rebuilds the cache when the catalog reference changes", () => {
    const g1 = buildGraph([table("a", "T", { rowCount: 50_000_000 })])
    const g2 = buildGraph([table("a", "T", { rowCount: 100 })])
    expect(isLargeObject("a.T", { accessor: () => g1 })).toBe(true)
    expect(isLargeObject("a.T", { accessor: () => g2 })).toBe(false)
  })
})

describe("listLargeObjects", () => {
  it("enumerates every object above threshold", () => {
    const g = buildGraph(
      [
        table("a", "Big", { rowCount: 50_000_000 }),
        table("b", "Small", { rowCount: 100 }),
        table("c", "WideView", { type: "VIEW" }),
      ],
      { viewSourceRows: [{ name: "c.WideView", sourceRows: 200_000_000 }] },
    )
    const names = listLargeObjects({ accessor: () => g })
    expect(names.has("a.big")).toBe(true)
    expect(names.has("c.wideview")).toBe(true)
    expect(names.has("b.small")).toBe(false)
  })
})

describe("unionBranchCount / isUnionView / isExpensiveUnionView", () => {
  const wideViewDef = `
    SELECT a, b FROM s.t1
    UNION ALL SELECT a, b FROM s.t2
    UNION ALL SELECT a, b FROM s.t3
    UNION ALL SELECT a, b FROM s.t4
    UNION ALL SELECT a, b FROM s.t5
    UNION ALL SELECT a, b FROM s.t6
    UNION ALL SELECT a, b FROM s.t7
    UNION ALL SELECT a, b FROM s.t8
  `

  it("returns 0 for tables", () => {
    const g = buildGraph([table("a", "T")])
    expect(unionBranchCount("a.T", { accessor: () => g })).toBe(0)
    expect(isUnionView("a.T", { accessor: () => g })).toBe(false)
  })

  it("counts UNION ALL branches in viewDefinition", () => {
    const g = buildGraph([table("a", "V", { type: "VIEW", viewDefinition: wideViewDef })])
    expect(unionBranchCount("a.V", { accessor: () => g })).toBe(8)
    expect(isUnionView("a.V", { accessor: () => g })).toBe(true)
  })

  it("prefers lineage.sources.length when present", () => {
    const fakeLineage: ViewLineage = {
      view: "a.V",
      description: "",
      outputColumns: [],
      dimJoins: [],
      sources: Array.from({ length: 20 }, (_, i) => ({
        qualifiedName: `s.b${i}`,
        businessArea: "",
        description: "",
        columns: [],
      })),
    } as unknown as ViewLineage
    const g = buildGraph(
      [table("a", "V", { type: "VIEW", viewDefinition: "SELECT * FROM s.b0" })],
      { lineage: [fakeLineage] },
    )
    expect(unionBranchCount("a.V", { accessor: () => g })).toBe(20)
  })

  it("ignores UNION inside string literals or comments", () => {
    const tricky = `SELECT 'UNION ALL not a real branch' AS msg FROM s.t1
                    -- UNION ALL also fake
                    /* UNION ALL fake too */`
    const g = buildGraph([table("a", "V", { type: "VIEW", viewDefinition: tricky })])
    expect(unionBranchCount("a.V", { accessor: () => g })).toBe(1)
  })

  it("isExpensiveUnionView fires at threshold and not below", () => {
    const g = buildGraph([table("a", "V", { type: "VIEW", viewDefinition: wideViewDef })])
    expect(isExpensiveUnionView("a.V", { accessor: () => g })).toBe(true)
    expect(isExpensiveUnionView("a.V", { accessor: () => g, threshold: 50 })).toBe(false)
  })

  it("listExpensiveUnionViews returns the lowercased name → branchCount map", () => {
    const g = buildGraph([table("X", "BigUnion", { type: "VIEW", viewDefinition: wideViewDef })])
    const m = listExpensiveUnionViews({ accessor: () => g })
    expect(m.get("x.bigunion")).toBe(8)
  })
})

describe("primaryKeyColumns / highCardinalityKeyColumns", () => {
  it("primaryKeyColumns reads isPK from the catalog", () => {
    const g = buildGraph([
      table("a", "T", { columns: [col("id", "int", true), col("name", "nvarchar")] }),
    ])
    expect(primaryKeyColumns("a.T", { accessor: () => g })).toEqual(["id"])
  })

  it("highCardinalityKeyColumns flags PK columns + FK-out targeting central dims", () => {
    const dim = table("d", "Centre", {
      columns: [col("dimKey", "int", true)],
      fkIncoming: [
        // Mark this dimension as "centrally referenced" — many incoming FKs.
        { constraint: "fk1", fromSchema: "f", fromTable: "F1", fromColumn: "dimKey", toSchema: "d", toTable: "Centre", toColumn: "dimKey" },
        { constraint: "fk2", fromSchema: "f", fromTable: "F2", fromColumn: "dimKey", toSchema: "d", toTable: "Centre", toColumn: "dimKey" },
        { constraint: "fk3", fromSchema: "f", fromTable: "F3", fromColumn: "dimKey", toSchema: "d", toTable: "Centre", toColumn: "dimKey" },
      ],
    })
    const fact = table("f", "F1", {
      columns: [col("factId", "int", true), col("dimKey", "int")],
      fkOutgoing: [
        { constraint: "fk1", fromSchema: "f", fromTable: "F1", fromColumn: "dimKey", toSchema: "d", toTable: "Centre", toColumn: "dimKey" },
      ],
    })
    const g = buildGraph([dim, fact])
    expect(highCardinalityKeyColumns("f.F1", { accessor: () => g }).sort()).toEqual(["dimKey", "factId"])
  })
})

describe("dateGrainColumn / calendarDimensionTable", () => {
  it("finds the FK to a small calendar-shaped dimension", () => {
    const cal = table("ref", "Period", {
      rowCount: 1200,
      columns: [col("periodId", "int", true), col("periodDate", "date")],
    })
    const fact = table("biz", "Sales", {
      rowCount: 50_000_000,
      columns: [col("salesId", "bigint", true), col("periodId", "int")],
      fkOutgoing: [
        { constraint: "fk", fromSchema: "biz", fromTable: "Sales", fromColumn: "periodId", toSchema: "ref", toTable: "Period", toColumn: "periodId" },
      ],
    })
    const g = buildGraph([cal, fact])
    expect(dateGrainColumn("biz.Sales", { accessor: () => g })).toBe("periodId")
    expect(calendarDimensionTable({ accessor: () => g })).toBe("ref.Period")
  })

  it("falls back to a direct date column on the table itself", () => {
    const g = buildGraph([
      table("biz", "Audit", { columns: [col("id", "int", true), col("at", "datetime2")] }),
    ])
    expect(dateGrainColumn("biz.Audit", { accessor: () => g })).toBe("at")
  })

  it("returns null when neither pattern matches", () => {
    const g = buildGraph([table("biz", "Plain", { columns: [col("id"), col("name", "nvarchar")] })])
    expect(dateGrainColumn("biz.Plain", { accessor: () => g })).toBeNull()
  })
})

describe("persistedMirrorOf", () => {
  it("returns null when no mirror schema is configured", () => {
    const g = buildGraph([table("a", "V", { type: "VIEW" })])
    expect(persistedMirrorOf("a.V", { accessor: () => g })).toBeNull()
  })

  it("returns the mirror qualifiedName when one exists under the configured schema", () => {
    const g = buildGraph([
      table("base", "BigView", { type: "VIEW" }),
      table("mirror", "base.BigView"),
    ])
    expect(persistedMirrorOf("base.BigView", { accessor: () => g, mirrorSchema: "mirror" }))
      .toBe("mirror.base.BigView")
  })

  it("returns null when the mirror table does not exist", () => {
    const g = buildGraph([table("base", "BigView", { type: "VIEW" })])
    expect(persistedMirrorOf("base.BigView", { accessor: () => g, mirrorSchema: "mirror" })).toBeNull()
  })
})

describe("listSchemas / topNTables / topNUnionViews", () => {
  it("listSchemas returns distinct lowercased schemas", () => {
    const g = buildGraph([
      table("Alpha", "T1"), table("ALPHA", "T2"), table("beta", "T3"),
    ])
    expect(listSchemas({ accessor: () => g })).toEqual(["alpha", "beta"])
  })

  it("topNTables ranks by rowCount", () => {
    const g = buildGraph([
      table("a", "Small", { rowCount: 10 }),
      table("a", "Big", { rowCount: 1_000_000 }),
      table("a", "Mid", { rowCount: 500 }),
    ])
    const top = topNTables(2, { accessor: () => g })
    expect(top.map((t) => t.qualifiedName)).toEqual(["a.Big", "a.Mid"])
  })

  it("topNUnionViews ranks by branchCount then sourceRows", () => {
    const v8 = "SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8"
    const v2 = "SELECT 1 UNION ALL SELECT 2"
    const g = buildGraph(
      [
        table("a", "Wide", { type: "VIEW", viewDefinition: v8 }),
        table("a", "Narrow", { type: "VIEW", viewDefinition: v2 }),
      ],
      { viewSourceRows: [{ name: "a.Wide", sourceRows: 1_000 }, { name: "a.Narrow", sourceRows: 1_000 }] },
    )
    const top = topNUnionViews(5, { accessor: () => g })
    expect(top.map((r) => r.table.qualifiedName)).toEqual(["a.Wide", "a.Narrow"])
    expect(top[0]?.branchCount).toBe(8)
  })
})
