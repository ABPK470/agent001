import { describe, expect, it } from "vitest"
import { validateQueryDetailed } from "../src/tools/mssql/validation.js"

describe("validateQueryDetailed — alias bracket auto-fix", () => {
  it("normalizes dim.Officer off and returns preparedQuery for execution", () => {
    const sql = "SELECT off.OfficerName FROM dim.Officer off WHERE off.pkOfficer = 1"
    const v = validateQueryDetailed(sql, false)
    expect(v.ok).toBe(true)
    expect(v.preparedQuery).toContain("FROM dim.Officer AS [off]")
    expect(v.preparedQuery).toContain("[off].[OfficerName]")
    expect(v.preparedQuery).not.toMatch(/\boff\./)
  })
})
