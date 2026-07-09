import { describe, expect, it, vi } from "vitest"

import type { ConnectionPool } from "mssql"

import { resolveValueSource } from "./value-source-resolver.js"
import type { ValueSourceResolveContext } from "./value-source-resolver.js"
import { StepOutputRegistry } from "./step-output-registry.js"

vi.mock("./db-helpers.js", () => ({
  trackedQuery: vi.fn().mockImplementation(async (_host, _conn, sql: string) => {
    if (sql.includes("core.Contract")) {
      return { recordset: [{ name: "MyContract" }] }
    }
    return { recordset: [{ inputDatasetId: 99 }] }
  }),
}))

function ctx(overrides?: Partial<ValueSourceResolveContext>): ValueSourceResolveContext {
  const stepOutputs = new StepOutputRegistry()
  stepOutputs.publish("priorStep", { datasetId: 501 })
  return {
    host: {} as never,
    plan: { source: "DEV", target: "UAT" } as never,
    entityId: 788,
    entityType: "contract",
    srcPool: { request: () => ({ input: vi.fn() }) } as unknown as ConnectionPool,
    tgtPool: { request: () => ({ input: vi.fn() }) } as unknown as ConnectionPool,
    stepOutputs,
    customValueSources: {},
    ...overrides,
  }
}

describe("resolveValueSource", () => {
  it("resolves contractName via builtin target SQL", async () => {
    const value = await resolveValueSource(
      { type: "contractName" },
      ctx(),
      { id: "step" },
    )
    expect(value).toBe("MyContract")
  })

  it("resolves ruleInputDatasetId to numeric id", async () => {
    const value = await resolveValueSource(
      { type: "ruleInputDatasetId" },
      ctx({ entityType: "rule", entityId: 12 }),
      { id: "datasetDeploy" },
    )
    expect(value).toBe(99)
  })

  it("resolves currentStepId to step id", async () => {
    const value = await resolveValueSource(
      { type: "currentStepId" },
      ctx(),
      { id: "myStep" },
    )
    expect(value).toBe("myStep")
  })

  it("resolves priorOutput from step output registry", async () => {
    const value = await resolveValueSource(
      { type: "priorOutput", stepId: "priorStep", output: "datasetId" },
      ctx(),
      { id: "laterStep" },
    )
    expect(value).toBe(501)
  })

  it("reads stepField from step properties", async () => {
    const value = await resolveValueSource(
      { type: "stepField", field: "auditObjectType" },
      ctx(),
      { id: "auditCheck", auditObjectType: "Contract" },
    )
    expect(value).toBe("Contract")
  })
})
