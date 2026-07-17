// Guardrail: validator codes (the actual gate) and doctrine codes (the SSoT)
// must stay aligned. Any time the validator blocks a query for a structural
// reason, at least one doctrine should be capable of explaining it.

import { describe, expect, it } from "vitest"
import { enforceDoctrines } from "../src/core/doctrine.js"
import { validateQueryDetailed } from "../src/tools/database/mssql/validation.js"

interface Case {
  readonly name: string
  readonly sql: string
  readonly expectedValidatorCode: string
  readonly expectedDoctrineCode: string
}

const CASES: readonly Case[] = [
  {
    name: "large_object_overused",
    sql: [
      "SELECT a.pkClient",
      "FROM publish.Revenue a",
      "JOIN publish.Revenue b ON b.pkClient = a.pkClient",
      "JOIN publish.Revenue c ON c.pkClient = a.pkClient",
      "WHERE a.pkMonth = 202501"
    ].join("\n"),
    expectedValidatorCode: "large_object_overused",
    expectedDoctrineCode: "large_object_overused"
  },
  {
    name: "aggregate_semantic_mismatch",
    sql: "SELECT SUM(b.AverageCreditBalanceZARMTD) AS AvgCreditBalZAR FROM #x_a3f91c08 b WHERE b.pkMonth = 1",
    expectedValidatorCode: "aggregate_semantic_mismatch",
    expectedDoctrineCode: "aggregate_semantic_mismatch"
  },
  {
    name: "temp_table_integrity",
    sql: "CREATE TABLE #range_a3f91c0 (x int); SELECT * FROM #range_a3f91c0; DROP TABLE #range_a3f91c0;",
    expectedValidatorCode: "temp_table_integrity",
    expectedDoctrineCode: "temp_table_integrity"
  }
]

describe("validator ↔ doctrine alignment", () => {
  for (const c of CASES) {
    it(`${c.name}: validator and doctrine agree`, () => {
      const v = validateQueryDetailed(c.sql, /* writeEnabled */ false)
      expect(v.ok, "validator should block this case").toBe(false)
      expect(v.code).toBe(c.expectedValidatorCode)

      const diags = enforceDoctrines(c.sql)
      expect(
        diags.some((d) => d.code === c.expectedDoctrineCode),
        `doctrine block missing for ${c.name}; got: ${diags.map((d) => d.code).join(",") || "none"}`
      ).toBe(true)
    })
  }
})
