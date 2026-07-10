import { describe, expect, it } from "vitest"

import { formatHandlerInputPreviewHint } from "./binding-display.js"

describe("formatHandlerInputPreviewHint", () => {
  it("uses catalog preview labels", () => {
    expect(
      formatHandlerInputPreviewHint(
        { name: "ContractName", source: { type: "catalog", id: "contractName" } },
        {
          customCatalog: {
            contractName: {
              description: "Contract name on target",
              resolver: {
                kind: "targetSql",
                query: "SELECT [name] FROM core.Contract WHERE contractId = @entityId",
                resultColumn: "name",
                resultType: "string",
              },
            },
          },
          customLabels: { contractName: "Contract name" },
        },
      ),
    ).toContain("Contract name")
  })

  it("marks step-bound slots", () => {
    expect(formatHandlerInputPreviewHint({ name: "datasetId" }, {})).toBe("per flow step")
  })
})
