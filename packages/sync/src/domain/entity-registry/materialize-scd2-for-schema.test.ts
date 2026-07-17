import { describe, expect, it } from "vitest"

import {
  materializeScd2PolicyForSchema,
  formatScd2PolicyOmissionSummary,
} from "./scd2-policy.js"
import { materializeDefinitionTablesForSchema } from "./materialize-scd2-for-schema.js"

describe("materializeScd2PolicyForSchema", () => {
  it("omits validTo stamps when column is absent on source and target", () => {
    const base = {
      excludeFromDiff: ["validFrom", "validTo", "syncDate"],
      onInsert: { validFrom: "GETUTCDATE()", validTo: "NULL" },
      onUpdate: { validFrom: "GETUTCDATE()", validTo: "NULL" },
      identityHandling: "none" as const,
    }
    const sourceCols = ["datasetMappingId", "name", "validFrom"]
    const targetCols = ["datasetMappingId", "name", "validFrom"]

    const { policy, omitted } = materializeScd2PolicyForSchema(base, sourceCols, targetCols)

    expect(policy.onInsert).toEqual({ validFrom: "GETUTCDATE()" })
    expect(policy.onUpdate).toEqual({ validFrom: "GETUTCDATE()" })
    expect(policy.excludeFromDiff).toEqual(["validFrom"])
    expect(omitted.onInsert).toContain("validTo")
    expect(omitted.onUpdate).toContain("validTo")
    expect(omitted.excludeFromDiff).toContain("validTo")
    expect(omitted.excludeFromDiff).toContain("syncDate")
  })

  it("materializes definition tables for preview plans", () => {
    const { tables, omissionSummaries } = materializeDefinitionTablesForSchema(
      [
        {
          name: "core.DatasetMapping",
          scopeColumn: null,
          predicate: "1=1",
          source: "manual",
          verified: true,
          groundedByPipeline: false,
          enabledByDefault: true,
          userControllable: false,
          scd2Policy: {
            excludeFromDiff: ["validFrom", "validTo"],
            onInsert: { validFrom: "GETUTCDATE()", validTo: "NULL" },
            onUpdate: { validFrom: "GETUTCDATE()", validTo: "NULL" },
            identityHandling: "none",
          },
        },
      ],
      new Map([["core.DatasetMapping", ["datasetMappingId", "validFrom"]]]),
      new Map([["core.DatasetMapping", ["datasetMappingId", "validFrom"]]]),
    )

    expect(tables[0]?.scd2Policy?.onInsert).toEqual({ validFrom: "GETUTCDATE()" })
    expect(omissionSummaries.some((s) => s.includes("validTo"))).toBe(true)
    expect(formatScd2PolicyOmissionSummary("core.T", {
      excludeFromDiff: [],
      onInsert: ["validTo"],
      onUpdate: [],
    })).toContain("validTo")
  })
})
