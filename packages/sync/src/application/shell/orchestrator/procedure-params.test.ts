import type { ConnectionPool } from "mssql"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { SyncFlowKindDefinition } from "@mia/shared-types"
import { trackedExecute, trackedQuery } from "./db-helpers.js"
import { executeMssqlProcedure } from "./procedure-params.js"
import { testFlowStepRunContext } from "../../../test-support/value-source-context.js"

vi.mock("./db-helpers.js", () => ({
  trackedExecute: vi.fn(),
  trackedQuery: vi.fn(),
}))

const trackedExecuteMock = vi.mocked(trackedExecute)
const trackedQueryMock = vi.mocked(trackedQuery)

const kind = (handler: SyncFlowKindDefinition["handler"]): SyncFlowKindDefinition => ({
  summary: "",
  description: "",
  handler,
  stepFields: {},
  failureMode: "warning",
})

describe("executeMssqlProcedure", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    trackedQueryMock.mockResolvedValue({ recordset: [{ name: "MyContract" }] } as never)
    trackedExecuteMock.mockResolvedValue({ recordsets: [[{ status: "success", message: "ok" }]] } as never)
  })

  it("executes procedure with explicit parameters", async () => {
    await executeMssqlProcedure(
      testFlowStepRunContext(),
      { id: "preScript", kind: "contractPreScript", title: "", description: "" },
      kind({
        type: "mssql_procedure",
        connection: "target",
        procedure: "core.uspRunContractDeploymentScripts",
        parameters: [
          { name: "contract-name", source: { type: "contractName" } },
          { name: "action", source: { type: "literal", value: "Run preScript" } },
          { name: "isDebug", source: { type: "literal", value: false } },
        ],
      }),
    )
    expect(trackedExecuteMock).toHaveBeenCalledWith(
      expect.anything(),
      "UAT",
      "core.uspRunContractDeploymentScripts",
      "flowStep.contractPreScript(preScript)",
      undefined,
      expect.anything(),
    )
  })

  it("returns createsDatasetLayer and publishes outputs", async () => {
    trackedExecuteMock.mockResolvedValue({
      recordsets: [[{ status: "success", datasetId: 42 }]],
    } as never)
    const result = await executeMssqlProcedure(
      testFlowStepRunContext(),
      { id: "createStage", kind: "contractCreateStageDataset", title: "", description: "" },
      {
        ...kind({
          type: "mssql_procedure",
          connection: "target",
          procedure: "core.uspCreateDataset",
          parameters: [
            { name: "ContractName", source: { type: "contractName" } },
            { name: "type", source: { type: "literal", value: "stage" } },
          ],
        }),
        createsDatasetLayer: true,
      },
    )
    expect(result.createsDatasetLayer).toBe(true)
    expect(result.outputs.ContractName).toBe("MyContract")
    expect(result.outputs.type).toBe("stage")
    expect(result.outputs.datasetId).toBe(42)
  })
})
