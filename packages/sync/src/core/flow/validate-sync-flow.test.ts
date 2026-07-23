import { describe, expect, it } from "vitest"

import { asEntityId } from "./types/branded-ids.js"
import { buildFlowCatalog } from "./flow-catalog.js"
import { loadDeployFlowCatalogForTests } from "../test-support/test-flow-catalog.js"
import { validateAuthoredSyncFlow } from "./validate-sync-flow.js"

describe("validateAuthoredSyncFlow", () => {
  const catalog = loadDeployFlowCatalogForTests()

  it("requires at least one step and metadataSync", () => {
    const result = validateAuthoredSyncFlow([], asEntityId("contract"), catalog)
    expect(result.errors.some((issue) => issue.message.includes("at least one step"))).toBe(true)
  })

  it("rejects unknown kinds at publish time", () => {
    const result = validateAuthoredSyncFlow(
      [
        {
          id: "audit",
          phase: "preTransaction",
          kind: "auditCheck",
          title: "Audit",
          description: "",
          auditObjectType: "Contract",
        },
        {
          id: "meta",
          phase: "metadata",
          kind: "metadataSync",
          title: "Metadata",
          description: "",
        },
        {
          id: "custom",
          phase: "postMetadata",
          kind: "customUnknownKind",
          title: "Custom",
          description: "",
        },
      ],
      asEntityId("contract"),
      catalog,
    )
    expect(result.errors.some((issue) => issue.kind === "customUnknownKind")).toBe(true)
  })

  it("accepts a minimal contract flow", () => {
    const result = validateAuthoredSyncFlow(
      [
        {
          id: "audit",
          phase: "preTransaction",
          kind: "auditCheck",
          title: "Audit",
          description: "",
          auditObjectType: "Contract",
        },
        {
          id: "meta",
          phase: "metadata",
          kind: "metadataSync",
          title: "Metadata",
          description: "",
        },
      ],
      asEntityId("contract"),
      catalog,
    )
    expect(result.errors).toHaveLength(0)
  })

  it("rejects custom_sql step types without SQL batch text", () => {
    const customCatalog = buildFlowCatalog([], [
      {
        id: "sqlOnly",
        label: "SQL only",
        definition_json: JSON.stringify({
          summary: "SQL",
          description: "",
          handler: { type: "custom_sql", connection: "target", sqlBatch: "" },
          stepFields: {},
          failureMode: "fatal",
        }),
      },
    ])
    const result = validateAuthoredSyncFlow(
      [
        { id: "meta", phase: "metadata", kind: "metadataSync", title: "Metadata", description: "" },
        { id: "sql", phase: "postMetadata", kind: "sqlOnly", title: "SQL", description: "" },
      ],
      asEntityId("contract"),
      customCatalog,
    )
    expect(result.errors.some((issue) => issue.message.includes("executable handler"))).toBe(true)
  })
})

describe("buildFlowCatalog", () => {
  it("overlays custom kind definitions from DB rows", () => {
    const catalog = buildFlowCatalog([], [
      {
        id: "myCustomStep",
        label: "My step",
        definition_json: JSON.stringify({
          summary: "Custom",
          description: "Runs a proc",
          handler: {
            type: "mssql_procedure",
            connection: "target",
            procedure: "ops.uspMyStep",
          },
          stepFields: {},
          failureMode: "warning",
          entityTypes: ["any"],
        }),
      },
    ])
    const def = catalog.resolveKind("myCustomStep")
    expect(def?.handler.procedure).toBe("ops.uspMyStep")
  })
})
