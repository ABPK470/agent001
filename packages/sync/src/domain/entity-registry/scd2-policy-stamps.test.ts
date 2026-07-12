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
        new Set(["validFrom", "syncDate", "name"]),
      ),
    ).toEqual({
      validFrom: "GETUTCDATE()",
      syncDate: "GETUTCDATE()",
    })
  })

  it("reports policy columns missing on target", () => {
    expect(
      scd2PolicyTargetColumnIssues(
        "core.DatasetMapping",
        {
          onInsert: { validFrom: "GETUTCDATE()", validTo: "NULL" },
          onUpdate: { validFrom: "GETUTCDATE()", validTo: "NULL" },
        },
        ["datasetMappingId", "validFrom"],
      ),
    ).toEqual(["core.DatasetMapping.validTo: missing on target (required by frozen scd2Policy)"])
  })
})
