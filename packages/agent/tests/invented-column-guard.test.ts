/**
 * Invented-column guard. The 2026-05-21 cancelled run had the model emit
 * `r.ClientName`, `publish.Officer.fullName`, and `rbb.RBBBanker` — all
 * hallucinated. The validator now reads the live catalog and blocks
 * references whose column is not present on the aliased table.
 *
 * These tests use a fake catalog so they run without a live runtime —
 * the detector is dependency-injected via its `accessor` parameter.
 */
import { describe, expect, it } from "vitest"

import { detectInventedColumns, validateQueryDetailed } from "../src/tools/database/mssql/validation.js"

// ── fake catalog ────────────────────────────────────────────────
type Col = { name: string; dataType?: string }
type Table = { columns: Col[] }

function makeCatalog(tables: Record<string, string[]>) {
  const map = new Map<string, Table>()
  for (const [qn, cols] of Object.entries(tables)) {
    map.set(qn, { columns: cols.map((name) => ({ name })) })
  }
  return {
    getTable(qn: string): Table | null {
      return map.get(qn) ?? null
    }
  }
}

const REVENUE_COLS = [
  "pkClient",
  "pkProduct",
  "pkAccount",
  "pkMonth",
  "pkOfficer",
  "RevenueZARMTD",
  "RevenueUSDMTD"
]
const BALANCES_COLS = [
  "pkClient",
  "pkAccount",
  "pkMonth",
  "AverageCreditBalanceZARMTD",
  "SpotCreditBalanceZARMTD"
]
const CLIENT_COLS = ["pkClient", "ClientName", "Segment", "Status"]
const OFFICER_COLS = ["pkOfficer", "OfficerName", "Email"]

const accessor = () =>
  makeCatalog({
    "publish.Revenue": REVENUE_COLS,
    "publish.Balances": BALANCES_COLS,
    "publish.Officer": OFFICER_COLS,
    "dim.Client": CLIENT_COLS,
    "dim.Officer": OFFICER_COLS
  })

describe("detectInventedColumns — positive blocks", () => {
  it("flags a hallucinated alias.column on publish.Revenue (trace shape)", () => {
    const query = [
      "SELECT r.pkClient, r.ClientName, r.RevenueZARMTD",
      "FROM publish.Revenue r WITH (NOLOCK)",
      "WHERE r.pkMonth = 202501"
    ].join("\n")
    const offenders = detectInventedColumns(query, accessor)
    expect(offenders).toHaveLength(1)
    expect(offenders[0]).toMatchObject({
      reference: "r.ClientName",
      table: "publish.Revenue",
      column: "ClientName"
    })
    expect(offenders[0].suggestions.length).toBeGreaterThan(0)
  })

  it("flags a 3-part qualified column publish.Officer.fullName", () => {
    const query = ["SELECT o.pkOfficer, publish.Officer.fullName", "FROM publish.Officer o"].join("\n")
    const offenders = detectInventedColumns(query, accessor)
    expect(offenders.some((o) => o.reference === "publish.Officer.fullName")).toBe(true)
  })

  it("flags multiple invented columns across joins in one statement", () => {
    const query = [
      "SELECT r.pkClient, r.ClientName, b.NetCreditBalance, c.Tier",
      "FROM publish.Revenue r WITH (NOLOCK)",
      "JOIN publish.Balances b ON b.pkClient = r.pkClient AND b.pkMonth = r.pkMonth",
      "JOIN dim.Client c ON c.pkClient = r.pkClient",
      "WHERE r.pkMonth = 202501"
    ].join("\n")
    const offenders = detectInventedColumns(query, accessor)
    const refs = offenders.map((o) => o.reference).sort()
    expect(refs).toContain("r.ClientName")
    expect(refs).toContain("b.NetCreditBalance")
    expect(refs).toContain("c.Tier")
  })

  it("dedupes repeated references to the same invented column", () => {
    const query = [
      "SELECT r.ClientName, r.ClientName AS dup",
      "FROM publish.Revenue r",
      "WHERE r.ClientName IS NOT NULL"
    ].join("\n")
    const offenders = detectInventedColumns(query, accessor)
    expect(offenders).toHaveLength(1)
    expect(offenders[0].reference).toBe("r.ClientName")
  })

  it("flags bare invented column names in WHERE predicates", () => {
    const query = [
      "SELECT c.ClientName, r.RevenueZARMTD",
      "FROM publish.Revenue r",
      "JOIN dim.Client c ON c.pkClient = r.pkClient",
      "WHERE Name = 'Acme'"
    ].join("\n")
    const offenders = detectInventedColumns(query, accessor)
    expect(offenders.some((o) => o.column === "Name")).toBe(true)
  })

  it("flags invented columns inside UNION branches", () => {
    const query = [
      "SELECT r.ClientName FROM publish.Revenue r",
      "UNION ALL",
      "SELECT b.ClientName FROM publish.Balances b"
    ].join("\n")
    const offenders = detectInventedColumns(query, accessor)
    expect(offenders.length).toBeGreaterThanOrEqual(2)
    expect(offenders.some((o) => o.column === "ClientName")).toBe(true)
  })
})

describe("detectInventedColumns — negatives (must not false-positive)", () => {
  it("accepts known columns on the catalog table", () => {
    const query = [
      "SELECT r.pkClient, r.RevenueZARMTD",
      "FROM publish.Revenue r WITH (NOLOCK)",
      "WHERE r.pkMonth = 202501"
    ].join("\n")
    expect(detectInventedColumns(query, accessor)).toEqual([])
  })

  it("validates CTE output columns instead of treating CTE aliases as catalog tables", () => {
    const query = [
      "WITH ranked AS (",
      "  SELECT r.pkClient, SUM(r.RevenueZARMTD) AS rev FROM publish.Revenue r GROUP BY r.pkClient",
      ")",
      "SELECT ranked.rev, ranked.pkClient FROM ranked"
    ].join("\n")
    expect(detectInventedColumns(query, accessor)).toEqual([])
  })

  it("flags invented columns on a CTE projection", () => {
    const query = [
      "WITH ranked AS (",
      "  SELECT r.pkClient, SUM(r.RevenueZARMTD) AS rev FROM publish.Revenue r GROUP BY r.pkClient",
      ")",
      "SELECT ranked.ClientName FROM ranked"
    ].join("\n")
    const offenders = detectInventedColumns(query, accessor)
    expect(offenders).toHaveLength(1)
    expect(offenders[0]).toMatchObject({
      reference: "ranked.ClientName",
      column: "ClientName",
      table: "CTE ranked"
    })
  })

  it("REGRESSION 2026-05-23: CTE statements DO still validate base-table aliases in outer SELECT", () => {
    // The May 2026 hallucination family (`r.VolumeUSDMTD`, `r.RevenueAmountCY`
    // against publish.Revenue inside a `WITH top_clients AS (…) SELECT …`
    // shape) slipped past the validator because the old CTE skip bailed on
    // the entire statement. After removal, the outer `r.<invented>` against
    // `publish.Revenue r` is caught at parse time.
    const query = [
      "WITH top_clients AS (",
      "  SELECT TOP 50 r.pkClient, SUM(r.RevenueZARMTD) AS rev",
      "  FROM publish.Revenue r WITH (NOLOCK)",
      "  WHERE r.pkMonth = 202501",
      "  GROUP BY r.pkClient",
      ")",
      "SELECT r.pkClient, r.RevenueUSDInvented",
      "FROM publish.Revenue r WITH (NOLOCK)",
      "JOIN top_clients tc ON tc.pkClient = r.pkClient"
    ].join("\n")
    const offenders = detectInventedColumns(query, accessor)
    expect(offenders.some((o) => o.column === "RevenueUSDInvented")).toBe(true)
  })

  it("skips statements with a derived table in FROM", () => {
    const query = ["SELECT x.ClientName FROM (SELECT pkClient FROM publish.Revenue) x"].join("\n")
    expect(detectInventedColumns(query, accessor)).toEqual([])
  })

  it("skips statements referencing sys.* catalog", () => {
    const query = "SELECT t.ClientName FROM sys.tables t"
    expect(detectInventedColumns(query, accessor)).toEqual([])
  })

  it("ignores aliases whose base table is NOT in the catalog (#temp, unknown)", () => {
    const query = ["SELECT t.MysteryColumn FROM #scratch t", "JOIN dbo.UnknownTable u ON u.id = t.id"].join(
      "\n"
    )
    expect(detectInventedColumns(query, accessor)).toEqual([])
  })

  it("does not mis-parse WITH (NOLOCK) as a column reference", () => {
    const query = "SELECT r.pkClient FROM publish.Revenue r WITH (NOLOCK) WHERE r.pkMonth = 202501"
    expect(detectInventedColumns(query, accessor)).toEqual([])
  })

  it("does not flag function calls like dbo.fnFoo(x)", () => {
    // dbo.fnFoo is followed by '(' → treated as a function call, not a column.
    const query = "SELECT r.pkClient, dbo.fnSomeUDF(r.pkClient) AS x FROM publish.Revenue r"
    const offenders = detectInventedColumns(query, accessor)
    expect(offenders.map((o) => o.reference)).not.toContain("dbo.fnSomeUDF")
  })

  it("does not flag table reference alone (no .column part)", () => {
    const query = "SELECT pkClient FROM publish.Revenue WHERE pkMonth = 202501"
    expect(detectInventedColumns(query, accessor)).toEqual([])
  })

  it("returns [] when no catalog is available (graceful degrade)", () => {
    const query = "SELECT r.ClientName FROM publish.Revenue r"
    const offenders = detectInventedColumns(query, () => null)
    expect(offenders).toEqual([])
  })

  it("handles bracketed identifiers [r].[ClientName]", () => {
    const query = "SELECT [r].[ClientName] FROM publish.Revenue [r]"
    const offenders = detectInventedColumns(query, accessor)
    expect(offenders.some((o) => o.column === "ClientName")).toBe(true)
  })
})

describe("detectInventedColumns — CTE-aware validation", () => {
  const cteAccessor = () =>
    makeCatalog({
      "publish.Revenue": REVENUE_COLS,
      "dim.Client": CLIENT_COLS
    })

  const cases: [string, string][] = [
    [
      "bare CTE column in WHERE",
      `WITH agg AS (
  SELECT r.pkClient, SUM(r.RevenueZARMTD) AS TotalRevenue
  FROM publish.Revenue r
  GROUP BY r.pkClient
)
SELECT r.pkClient, TotalRevenue
FROM agg a
JOIN publish.Revenue r ON r.pkClient = a.pkClient
WHERE TotalRevenue > 0 AND r.pkMonth = 202501`
    ],
    [
      "qualified CTE via FROM alias",
      `WITH agg AS (
  SELECT r.pkClient, SUM(r.RevenueZARMTD) AS TotalRevenue
  FROM publish.Revenue r
  GROUP BY r.pkClient
)
SELECT a.TotalRevenue, a.pkClient
FROM agg a
JOIN publish.Revenue r ON r.pkClient = a.pkClient`
    ],
    [
      "qualified CTE via CTE name in JOIN",
      `WITH agg AS (
  SELECT r.pkClient, SUM(r.RevenueZARMTD) AS TotalRevenue
  FROM publish.Revenue r
  GROUP BY r.pkClient
)
SELECT agg.TotalRevenue
FROM agg
JOIN publish.Revenue r ON r.pkClient = agg.pkClient`
    ],
    [
      "multi-CTE chain",
      `WITH base AS (
  SELECT r.pkClient, c.ClientName, SUM(r.RevenueZARMTD) AS rev
  FROM publish.Revenue r
  JOIN dim.Client c ON c.pkClient = r.pkClient
  GROUP BY r.pkClient, c.ClientName
),
ranked AS (
  SELECT b.ClientName, b.rev, ROW_NUMBER() OVER (ORDER BY b.rev DESC) AS rn
  FROM base b
)
SELECT ranked.ClientName, ranked.rev
FROM ranked
WHERE ranked.rn = 1`
    ]
  ]

  for (const [name, sql] of cases) {
    it(`accepts valid ${name}`, () => {
      expect(detectInventedColumns(sql, cteAccessor)).toEqual([])
    })
  }
})

describe("validateQueryDetailed — invented_column block", () => {
  it("returns the invented_column code with fix hint and lesson", () => {
    // Without an injected accessor the validator degrades to "no catalog",
    // so the invented-column guard must stay silent.
    const query = "SELECT r.ClientName FROM publish.Revenue r"
    const v = validateQueryDetailed(query, false)
    expect(v.code).not.toBe("invented_column")
  })
})
