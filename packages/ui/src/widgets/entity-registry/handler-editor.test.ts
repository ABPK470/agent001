import { describe, expect, it } from "vitest"
import type { SyncFlowKindDefinition } from "../../types"

import {
  defaultHandlerForType,
  defaultProcedureParameters,
  formatProcedureSummary,
  handlerConfigHighlight,
  infersCreatesDatasetLayer,
  wiringCatalogListItems,
} from "./handler-editor"

describe("handler-editor", () => {
  it("defaults mssql handler with id parameter", () => {
    expect(defaultHandlerForType("mssql_procedure")).toEqual({
      type: "mssql_procedure",
      connection: "target",
      procedure: "core.uspCustomStep",
      parameters: [{ name: "id", source: { type: "catalog", id: "planEntityId" } }],
    })
  })

  it("summarizes procedure and parameters", () => {
    expect(
      formatProcedureSummary({
        type: "mssql_procedure",
        connection: "target",
        procedure: "core.uspRunContractDeploymentScripts",
        parameters: [
          { name: "contractName", source: { type: "catalog", id: "contractName" } },
          { name: "action", source: { type: "literal", value: "Run preScript" } },
        ],
      }),
    ).toContain("uspRunContractDeploymentScripts")
  })

  it("highlights configured procedure as explicit call preview", () => {
    const def: SyncFlowKindDefinition = {
      summary: "",
      description: "",
      handler: {
        type: "mssql_procedure" as const,
        connection: "target" as const,
        procedure: "core.uspCreateDataset",
        parameters: [
          { name: "ContractName", source: { type: "catalog", id: "contractName" } },
          { name: "type", source: { type: "literal", value: "stage" } },
        ],
      },
      stepFields: {},
      failureMode: "warning" as const,
      createsDatasetLayer: true,
    }
    const catalog = {
      contractName: {
        description: "Contract name",
        resolver: {
          kind: "targetSql" as const,
          query: "SELECT [name] FROM core.Contract WHERE contractId = @entityId",
          resultColumn: "name",
          resultType: "string" as const,
        },
      },
    }
    expect(handlerConfigHighlight(def, catalog)).toContain("EXEC core.uspCreateDataset")
    expect(handlerConfigHighlight(def, catalog)).toContain("@ContractName ← Query: contractName")
    expect(handlerConfigHighlight(def, catalog)).toContain("@type = 'stage'")
    expect(handlerConfigHighlight(def, catalog)).not.toContain("SQL on target")
    expect(infersCreatesDatasetLayer(def)).toBe(true)
  })

  it("defaults custom handler types", () => {
    expect(defaultProcedureParameters()).toEqual([{ name: "id", source: { type: "catalog", id: "planEntityId" } }])
    expect(defaultHandlerForType("custom_sql").sqlBatch).toBe("")
  })

  it("lists value sources from the catalog", () => {
    const items = wiringCatalogListItems([
      {
        id: "planEntityId",
        label: "Plan entity id",
        builtIn: true,
        definition: { description: "Entity id", resolver: { kind: "planEntityId" } },
      },
      {
        id: "myLookup",
        label: "My lookup",
        builtIn: false,
        definition: {
          description: "Custom",
          resolver: {
            kind: "targetSql",
            query: "SELECT 1 AS x FROM core.Contract WHERE contractId = @entityId",
            resultColumn: "x",
          },
        },
      },
    ])
    expect(items.some((item) => item.id === "planEntityId")).toBe(true)
    expect(items.some((item) => item.id === "myLookup")).toBe(true)
  })
})
