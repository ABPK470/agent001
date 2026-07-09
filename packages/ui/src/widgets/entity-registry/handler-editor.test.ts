import { describe, expect, it } from "vitest"

import {
  defaultHandlerForType,
  defaultProcedureParameters,
  formatProcedureSummary,
  handlerConfigHighlight,
  infersCreatesDatasetLayer,
} from "./handler-editor"

describe("handler-editor", () => {
  it("defaults mssql handler with id parameter", () => {
    expect(defaultHandlerForType("mssql_procedure")).toEqual({
      type: "mssql_procedure",
      connection: "target",
      procedure: "core.uspCustomStep",
      parameters: [{ name: "id", source: { type: "planEntityId" } }],
    })
  })

  it("summarizes procedure and parameters", () => {
    expect(
      formatProcedureSummary({
        type: "mssql_procedure",
        connection: "target",
        procedure: "core.uspRunContractDeploymentScripts",
        parameters: [
          { name: "contractName", source: { type: "contractName" } },
          { name: "action", source: { type: "literal", value: "Run preScript" } },
        ],
      }),
    ).toContain("uspRunContractDeploymentScripts")
  })

  it("highlights configured procedure as explicit call preview", () => {
    const def = {
      summary: "",
      description: "",
      handler: {
        type: "mssql_procedure" as const,
        connection: "target" as const,
        procedure: "core.uspCreateDataset",
        parameters: [
          { name: "ContractName", source: { type: "contractName" as const } },
          { name: "type", source: { type: "literal", value: "stage" } },
        ],
      },
      stepFields: {},
      failureMode: "warning" as const,
      createsDatasetLayer: true,
    }
    expect(handlerConfigHighlight(def)).toContain("EXEC core.uspCreateDataset")
    expect(handlerConfigHighlight(def)).toContain("@ContractName ← Query: Contract name")
    expect(handlerConfigHighlight(def)).toContain("@type = 'stage'")
    expect(handlerConfigHighlight(def)).not.toContain("SQL on target")
    expect(infersCreatesDatasetLayer(def)).toBe(true)
  })

  it("defaults custom handler types", () => {
    expect(defaultProcedureParameters()).toEqual([{ name: "id", source: { type: "planEntityId" } }])
    expect(defaultHandlerForType("custom_sql").sqlBatch).toBe("")
  })
})
