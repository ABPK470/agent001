import { describe, expect, it } from "vitest"
import {
  blocksOperation,
  operationForTool,
  requirementForFinding
} from "../src/runtime/execution/clarification-gate.js"

describe("clarification gate", () => {
  it("keeps discovery available while a data interpretation is unresolved", () => {
    const requirement = requirementForFinding({ kind: "schema-match", severity: "block" })
    expect(blocksOperation(requirement, operationForTool("search_catalog", {}))).toBe(false)
    expect(
      blocksOperation(requirement, operationForTool("query_mssql", { query: "SELECT * FROM Sales" }))
    ).toBe(true)
  })

  it("reserves confirmation findings for mutations, not read-only investigation", () => {
    const requirement = requirementForFinding({ kind: "write-confirmation", severity: "block" })
    expect(blocksOperation(requirement, operationForTool("query_mssql", { query: "SELECT 1" }))).toBe(false)
    expect(
      blocksOperation(requirement, operationForTool("query_mssql", { query: "DELETE FROM Sales" }))
    ).toBe(true)
  })

  it("fails closed for unclassified tools", () => {
    expect(operationForTool("future_tool", {})).toBe("mutation")
  })
})
