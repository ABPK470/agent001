import { describe, expect, it, vi } from "vitest"

import type { ConnectionPool } from "mssql"

import { runHttpFlowStep } from "./http-flow-step.js"
import { StepOutputRegistry } from "./step-output-registry.js"
import { TEST_VALUE_SOURCE_CATALOG } from "../../../test-support/value-source-catalog.js"

describe("runHttpFlowStep", () => {
  it("resolves httpBody via value sources — same path as any HTTP step type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ jobId: "job-99", status: "queued" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const ctx = {
      host: {
        sync: {
          environments: {
            items: new Map([
              [
                "UAT",
                {
                  name: "UAT",
                  etlServiceBaseUrl: "https://etl.example",
                },
              ],
            ]),
          },
        },
      } as never,
      plan: { source: "DEV", target: "UAT" } as never,
      entityId: 791,
      entityType: "rule",
      srcPool: {} as ConnectionPool,
      tgtPool: { request: () => ({ input: vi.fn() }) } as unknown as ConnectionPool,
      userUpn: "user@example.com",
      resolveContractName: async () => "C",
      customValueSources: TEST_VALUE_SOURCE_CATALOG,
      stepOutputs: new StepOutputRegistry(),
    }

    const result = await runHttpFlowStep(
      ctx,
      { id: "rulesDeploy", kind: "rulesDeploy", title: "", description: "" },
      {
        summary: "",
        description: "",
        handler: {
          type: "http_request",
          connection: "target",
          httpService: "etl",
          httpMethod: "POST",
          httpPath: "/rules/deploy",
          httpBody: [
            { name: "ruleId", source: { type: "planEntityId" } },
            { name: "userFullName", source: { type: "planActor" } },
          ],
        },
        stepFields: {},
        failureMode: "warning",
      },
    )

    expect(fetchMock).toHaveBeenCalledWith(
      "https://etl.example/rules/deploy",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ ruleId: 791, userFullName: "user@example.com" }),
      }),
    )
    expect(result.outputs).toEqual({
      ruleId: 791,
      userFullName: "user@example.com",
      jobId: "job-99",
      status: "queued",
    })

    vi.unstubAllGlobals()
  })
})
