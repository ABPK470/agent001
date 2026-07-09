import { describe, expect, it } from "vitest"

import { stepFieldKeysForStep, stepFieldKeysFromHandler } from "./flow-step-bindings.js"

describe("stepFieldKeysFromHandler", () => {
  it("collects step field keys from handler slots", () => {
    expect(
      stepFieldKeysFromHandler({
        type: "mssql_procedure",
        connection: "source",
        procedure: "core.uspAuditRunCheck",
        parameters: [
          { name: "id", source: { type: "planEntityId" } },
          { name: "objType", source: { type: "stepField", field: "auditObjectType" } },
        ],
      }),
    ).toEqual(["auditObjectType"])
  })
})

describe("stepFieldKeysForStep", () => {
  it("reads required fields from handler wiring", () => {
    expect(
      stepFieldKeysForStep(
        {},
        {
          handler: {
            type: "mssql_procedure",
            connection: "source",
            procedure: "p",
            parameters: [{ name: "objType", source: { type: "stepField", field: "auditObjectType" } }],
          },
        },
      ),
    ).toEqual(["auditObjectType"])
  })
})
