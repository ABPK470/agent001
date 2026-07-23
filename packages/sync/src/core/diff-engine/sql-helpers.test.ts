import { describe, expect, it } from "vitest"

import {
  buildBatchWhere,
  formatScalar,
  isTransientMssqlError,
  qtable,
  quoteValue
} from "./sql-helpers.js"

describe("sql-helpers", () => {
  it("qtable brackets schema.table identifiers", () => {
    expect(qtable("core.Pipeline")).toBe("[core].[Pipeline]")
    expect(qtable("gate.Content")).toBe("[gate].[Content]")
  })

  it("quoteValue renders SQL literals", () => {
    expect(quoteValue(null)).toBe("NULL")
    expect(quoteValue(42)).toBe("42")
    expect(quoteValue("O'Brien")).toBe("N'O''Brien'")
    expect(quoteValue(true)).toBe("1")
    expect(quoteValue(false)).toBe("0")
  })

  it("formatScalar stringifies values for human summaries", () => {
    expect(formatScalar(null)).toBe("NULL")
    expect(formatScalar(99)).toBe("99")
    expect(formatScalar("x")).toBe("'x'")
  })

  it("buildBatchWhere ORs PK equality clauses", () => {
    const where = buildBatchWhere(
      [
        { pk: "1", rowHash: "a", pkValues: { pipelineId: 1, contractId: 9 } },
        { pk: "2", rowHash: "b", pkValues: { pipelineId: 2, contractId: 9 } }
      ],
      ["pipelineId", "contractId"]
    )
    expect(where).toContain("[pipelineId] = 1")
    expect(where).toContain("[contractId] = 9")
    expect(where).toContain(" OR ")
  })

  it("isTransientMssqlError detects retryable connection failures", () => {
    expect(isTransientMssqlError(new Error("Connection is closed."))).toBe(true)
    expect(isTransientMssqlError(Object.assign(new Error("x"), { code: "ETIMEOUT" }))).toBe(true)
    expect(isTransientMssqlError(new Error("syntax error"))).toBe(false)
  })
})
