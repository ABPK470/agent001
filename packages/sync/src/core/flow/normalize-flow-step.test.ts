import { describe, expect, it } from "vitest"

import { defaultStepBindings, normalizeAuthoredSyncFlowStep } from "@mia/shared-types"

describe("normalizeAuthoredSyncFlowStep", () => {
  it("fills step field values from action wiring", () => {
    const steps = normalizeAuthoredSyncFlowStep(
      {
        id: "auditCheck",
        kind: "auditCheck",
        title: "Audit",
        description: "",
      },
      { entityId: "contract", rootTable: "core.Contract" },
      {
        resolveKind(kindId) {
          if (kindId !== "auditCheck") return undefined
          return {
            summary: "Audit",
            description: "",
            handler: {
              type: "mssql_procedure",
              connection: "source",
              procedure: "core.uspAuditRunCheck",
              parameters: [
                { name: "id", source: { type: "catalog", id: "planEntityId" } },
                { name: "objType", source: { type: "catalog", id: "auditObjectType" } },
                { name: "action", source: { type: "literal", value: "syncOrNot" } },
              ],
            },
            stepFields: {},
            failureMode: "fatal",
          }
        },
      },
    )
    expect(steps.auditObjectType).toBe("Contract")
    expect(steps.bindings).toEqual({})
  })

  it("preserves explicit empty step field values", () => {
    const step = normalizeAuthoredSyncFlowStep(
      {
        id: "pipelineStart",
        kind: "pipelineStart",
        title: "Start",
        description: "",
        pipelineName: "",
      },
      { entityId: "contract", rootTable: "core.Contract" },
      {
        resolveKind(kindId) {
          if (kindId !== "pipelineStart") return undefined
          return {
            summary: "Start pipeline",
            description: "",
            handler: {
              type: "http_request",
              connection: "target",
              httpMethod: "POST",
              httpService: "etl",
              httpPath: "/pipeline/start",
              httpBody: [{ name: "name", source: { type: "catalog", id: "pipelineName" } }],
            },
            stepFields: {},
            failureMode: "warning",
          }
        },
      },
    )
    expect(step.pipelineName).toBe("")
  })

  it("fills unset step field values with suggested defaults", () => {
    const step = normalizeAuthoredSyncFlowStep(
      {
        id: "pipelineStart",
        kind: "pipelineStart",
        title: "Start",
        description: "",
      },
      { entityId: "contract", rootTable: "core.Contract" },
      {
        resolveKind(kindId) {
          if (kindId !== "pipelineStart") return undefined
          return {
            summary: "Start pipeline",
            description: "",
            handler: {
              type: "http_request",
              connection: "target",
              httpMethod: "POST",
              httpService: "etl",
              httpPath: "/pipeline/start",
              httpBody: [{ name: "name", source: { type: "catalog", id: "pipelineName" } }],
            },
            stepFields: {},
            failureMode: "warning",
          }
        },
      },
    )
    expect(step.pipelineName).toBe("Synchronize Contract")
  })
})

describe("defaultStepBindings", () => {
  it("suggests rule input dataset id for dataset deploy on rules", () => {
    expect(
      defaultStepBindings(
        { kind: "datasetDeploy" },
        "rule",
        {
          summary: "",
          description: "",
          handler: {
            type: "http_request",
            connection: "target",
            httpBody: [{ name: "datasetId" }],
          },
          stepFields: {},
          failureMode: "warning",
        },
      ),
    ).toEqual({ datasetId: { type: "catalog", id: "ruleInputDatasetId" } })
  })
})
