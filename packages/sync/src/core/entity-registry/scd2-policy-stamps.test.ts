import { describe, expect, it } from "vitest"

import {
  filterPolicyStampsToTargetColumns,
  scd2PolicyTargetColumnIssues,
} from "./scd2-policy.js"

describe("scd2 policy stamp helpers", () => {
  it("keeps only stamp columns that exist on the target", () => {
    expect(
      filterPolicyStampsToTargetColumns(
        { validFrom: "GETUTCDATE()", validTo: "NULL", syncDate: "GETUTCDATE()" },
        ["validFrom", "syncDate", "name"],
      ),
    ).toEqual({
      validFrom: "GETUTCDATE()",
      syncDate: "GETUTCDATE()",
    })
  })

  it("reports omitted stamp columns as informational runtime notes", () => {
    expect(
      scd2PolicyTargetColumnIssues(
        "core.DatasetMapping",
        {
          onInsert: { validFrom: "GETUTCDATE()", validTo: "NULL" },
          onUpdate: { validFrom: "GETUTCDATE()", validTo: "NULL" },
        },
        ["datasetMappingId", "validFrom"],
      ),
    ).toEqual(["core.DatasetMapping.validTo: stamp column absent on target (omitted at runtime)"])
  })
})
