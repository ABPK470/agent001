import { describe, expect, it } from "vitest"

import type { SyncFlowKindDefinition } from "./index.js"
import { normalizeKindDefinition } from "./derive-step-fields.js"
import {
  assertPublishedOutputsPresent,
  computePublishedOutputsForKind,
  derivePublishedOutputsFromHandler,
  formatStepOutputPreviewJson,
  pruneStaleResultColumnKeys,
  publishedOutputKeysForKind,
  publishedOutputKeysForStep,
  stepOutputPreview,
} from "./step-published-outputs.js"

const auditCheckKind: SyncFlowKindDefinition = {
  summary: "",
  description: "",
  stepFields: {},
  failureMode: "fatal",
  handler: {
    type: "mssql_procedure",
    connection: "source",
    procedure: "core.uspAuditRunCheck",
    parameters: [
      { name: "id", source: { type: "catalog", id: "planEntityId" } },
      { name: "objType", source: { type: "catalog", id: "auditObjectType" } },
      { name: "action", source: { type: "literal", value: "syncOrNot" } },
      { name: "schema", source: { type: "literal", value: "core" } },
    ],
  },
  publishedOutputs: ["action", "id", "message", "objType", "schema", "status"],
}

describe("publishedOutputKeysForKind", () => {
  it("reads catalog publishedOutputs merged with procedure parameters", () => {
    expect(publishedOutputKeysForKind("audit-check", auditCheckKind)).toEqual([
      "action",
      "id",
      "message",
      "objType",
      "schema",
      "status",
    ])
  })

  it("includes procedure parameter names when catalog omits publishedOutputs", () => {
    const { publishedOutputs: _removed, ...withoutDeclaration } = auditCheckKind
    expect(publishedOutputKeysForKind("audit-check", withoutDeclaration)).toEqual([
      "action",
      "id",
      "objType",
      "schema",
    ])
  })

  it("derives handler input keys for http actions when catalog omits publishedOutputs", () => {
    expect(
      publishedOutputKeysForKind("datasetDeploy", {
        summary: "",
        description: "",
        stepFields: {},
        failureMode: "warning",
        handler: {
          type: "http_request",
          connection: "target",
          httpMethod: "POST",
          httpPath: "/deploy",
          httpBody: [{ name: "datasetId" }, { name: "userFullName" }],
        },
      }),
    ).toEqual(["datasetId", "userFullName"])
  })
})

describe("derivePublishedOutputsFromHandler", () => {
  it("returns nothing for procedures without catalog declaration", () => {
    expect(derivePublishedOutputsFromHandler(auditCheckKind)).toEqual([])
  })
})

describe("publishedOutputKeysForStep", () => {
  it("resolves keys from the selected step kind definition in catalog", () => {
    const keys = publishedOutputKeysForStep(
      "gate",
      [{ id: "gate", kind: "auditCheck", title: "", description: "" }],
      () => auditCheckKind,
    )
    expect(keys).toEqual(auditCheckKind.publishedOutputs)
  })
})

describe("pruneStaleResultColumnKeys", () => {
  it("drops abandoned param-name typing chains", () => {
    const stale = ["d", "i", "id", "id2", "id23", "id234", "id2345"]
    expect(pruneStaleResultColumnKeys(stale, ["dd"])).toEqual([])
  })

  it("keeps real result columns", () => {
    expect([...pruneStaleResultColumnKeys(["status", "message"], ["id", "action"])].sort()).toEqual([
      "message",
      "status",
    ])
  })
})

describe("computePublishedOutputsForKind", () => {
  it("clears stale keys when normalizing a custom action", () => {
    const kind: SyncFlowKindDefinition = {
      summary: "",
      description: "",
      stepFields: {},
      failureMode: "warning",
      handler: {
        type: "mssql_procedure",
        connection: "target",
        procedure: "core.uspCustomStep",
        parameters: [{ name: "dd", source: { type: "priorOutput", stepId: "targetLock", output: "isLocked" } }],
      },
      publishedOutputs: ["d", "dd", "i", "id", "id2", "id23", "id234", "id2345"],
    }
    expect(computePublishedOutputsForKind("custom", kind)).toEqual(["dd"])
    expect(normalizeKindDefinition(kind, "custom").publishedOutputs).toEqual(["dd"])
  })
})

describe("stepOutputPreview", () => {
  it("labels procedure inputs vs result columns", () => {
    const preview = stepOutputPreview("audit-check", auditCheckKind)
    expect(preview.example.id).toBe("<echoed input>")
    expect(preview.example.message).toBe("<from handler result>")
    expect(formatStepOutputPreviewJson(preview)).toContain('"message": "<from handler result>"')
  })
})

describe("assertPublishedOutputsPresent", () => {
  it("throws when a catalog key is missing from runtime outputs", () => {
    expect(() =>
      assertPublishedOutputsPresent(
        "audit-check",
        auditCheckKind,
        { status: "success" },
      ),
    ).toThrow(/publishes "action"/)
  })

  it("passes when all catalog keys are present", () => {
    expect(() =>
      assertPublishedOutputsPresent("audit-check", auditCheckKind, {
        action: "syncOrNot",
        id: 1,
        message: "ok",
        objType: "Contract",
        schema: "core",
        status: "success",
      }),
    ).not.toThrow()
  })

  it("skips validation when nothing is declared", () => {
    const { publishedOutputs: _removed, ...withoutDeclaration } = auditCheckKind
    expect(() =>
      assertPublishedOutputsPresent("audit-check", withoutDeclaration, {}),
    ).not.toThrow()
  })
})
