import { describe, expect, it } from "vitest"

import { formatMssqlExecLog } from "./db-helpers.js"

describe("formatMssqlExecLog", () => {
  it("includes bound parameter values for audit gate calls", () => {
    expect(
      formatMssqlExecLog("core.uspAuditRunCheck", {
        id: "42",
        objType: "Contract",
        action: "syncOrNot",
        schema: "core",
      }),
    ).toBe(
      "EXEC core.uspAuditRunCheck @id=N'42', @objType=N'Contract', @action=N'syncOrNot', @schema=N'core'",
    )
  })

  it("falls back to bare EXEC when there are no parameters", () => {
    expect(formatMssqlExecLog("core.uspFoo", {})).toBe("EXEC core.uspFoo")
  })
})
