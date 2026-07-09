import { describe, expect, it } from "vitest"

import { deriveStepFieldsFromHandler, normalizeKindDefinition } from "@mia/shared-types"

describe("derive-step-fields", () => {
  it("returns empty stepFields — bindings drive step field requirements", () => {
    expect(
      deriveStepFieldsFromHandler({
        type: "http_request",
        connection: "target",
        httpService: "etl",
        httpMethod: "POST",
        httpPath: "/dataset/deploy",
        httpBody: [{ name: "datasetId" }],
      }),
    ).toEqual({})
  })

  it("normalizes kind definition stepFields to empty", () => {
    const def = normalizeKindDefinition({
      summary: "x",
      description: "y",
      handler: {
        type: "mssql_procedure",
        connection: "target",
        procedure: "core.uspExample",
        parameters: [{ name: "objectName" }],
      },
      stepFields: { "object-name": true },
      failureMode: "warning",
      entityTypes: ["any"],
    })
    expect(def.stepFields).toEqual({})
  })
})
