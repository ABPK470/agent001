import { describe, it, expect } from "vitest"
import {
  normalizeMssqlAliasBrackets,
  validateAliasBracketConvention,
  prepareMssqlQueryAliases
} from "../src/tools/mssql/sql-alias-brackets.js"

describe("CTE alias repro (screenshot shape)", () => {
  it("normalizes a multi-CTE query with CTE-alias refs in main + nested CTE bodies", () => {
    const input = `WITH topClients AS (
  SELECT c.pkClient, c.ClientName, SUM(r.RevenueZAR) AS TotalRevenue
  FROM dim.Client c
  INNER JOIN publish.Revenue r ON r.pkClient = c.pkClient
  GROUP BY c.pkClient, c.ClientName
),
currentTopProduct AS (
  SELECT x.pkClient, x.pkProduct, x.ProductRevenueZAR,
    ROW_NUMBER() OVER (PARTITION BY x.pkClient ORDER BY x.ProductRevenueZAR DESC, x.pkProduct) AS rn
  FROM clientProduct x
)
SELECT tc.ClientName, tc.TotalRevenue, ctp.pkProduct, ctp.ProductRevenueZAR
FROM topClients tc
INNER JOIN dim.Client c WITH (NOLOCK) ON c.pkClient = tc.pkClient
LEFT JOIN dim.Officer o WITH (NOLOCK) ON o.pkOfficer = c.pkOfficer_PrimaryBanker
LEFT JOIN currentTopProduct ctp ON ctp.pkClient = tc.pkClient AND ctp.rn = 1`

    const prep = prepareMssqlQueryAliases(input)
    expect(prep.error).toBeNull()
    expect(prep.query).toContain("FROM [topClients] AS [tc]")
    expect(prep.query).toContain("LEFT JOIN [currentTopProduct] AS [ctp]")
    expect(prep.query).toContain("FROM [clientProduct] AS [x]")

    // Idempotent: a second pass must not double-bracket or report violations.
    const second = prepareMssqlQueryAliases(prep.query)
    expect(second.changed).toBe(false)
    expect(second.error).toBeNull()
    expect(second.query).toBe(prep.query)
  })

  it("leaves #temp source names bare (detectors rely on the literal # pattern)", () => {
    const input =
      "SELECT r.pkClient FROM #revLines_a3f91c08 r WHERE r.pkClient = base.pkClient"
    const { query } = normalizeMssqlAliasBrackets(input)
    expect(query).toContain("FROM #revLines_a3f91c08 AS [r]")
    expect(query).not.toContain("[#revLines_a3f91c08]")
    expect(query).toContain("[r].[pkClient]")
  })
})
