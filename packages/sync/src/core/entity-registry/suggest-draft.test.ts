import { describe, expect, it } from "vitest"

import {
  catalogSnapshotFromAgentJson,
  suggestEntityDraft,
  suggestEntityTable,
  suggestIdentityHeuristic,
} from "./suggest-draft.js"

const datasetCatalog = catalogSnapshotFromAgentJson({
  tables: [
    {
      schema: "core",
      name: "Dataset",
      qualifiedName: "core.Dataset",
      columns: [
        { name: "datasetId", isPK: true },
        { name: "name", isPK: false },
        { name: "parentDatasetId", isPK: false },
      ],
      fkOutgoing: [
        {
          fromSchema: "core",
          fromTable: "Dataset",
          fromColumn: "parentDatasetId",
          toSchema: "core",
          toTable: "Dataset",
          toColumn: "datasetId",
        },
      ],
    },
    {
      schema: "core",
      name: "Pipeline",
      qualifiedName: "core.Pipeline",
      columns: [
        { name: "pipelineId", isPK: true },
        { name: "datasetId", isPK: false },
      ],
      fkOutgoing: [
        {
          fromSchema: "core",
          fromTable: "Pipeline",
          fromColumn: "datasetId",
          toSchema: "core",
          toTable: "Dataset",
          toColumn: "datasetId",
        },
      ],
    },
    {
      schema: "core",
      name: "DatasetColumn",
      qualifiedName: "core.DatasetColumn",
      columns: [
        { name: "datasetColumnId", isPK: true },
        { name: "datasetId", isPK: false },
      ],
      fkOutgoing: [
        {
          fromSchema: "core",
          fromTable: "DatasetColumn",
          fromColumn: "datasetId",
          toSchema: "core",
          toTable: "Dataset",
          toColumn: "datasetId",
        },
      ],
    },
  ],
})

describe("suggestIdentityHeuristic", () => {
  it("derives camelCase id and columns from qualified root table", () => {
    expect(suggestIdentityHeuristic("core.Dataset")).toEqual({
      id: "dataset",
      displayName: "Dataset",
      description: "Sync definition for Dataset.",
      rootTable: "core.Dataset",
      idColumn: "datasetId",
      labelColumn: "name",
      selfJoinColumn: null,
    })
  })

  it("defaults schema to core when omitted", () => {
    expect(suggestIdentityHeuristic("Contract").rootTable).toBe("core.Contract")
  })
})

describe("suggestEntityDraft", () => {
  it("returns heuristic-only draft without catalog", () => {
    const draft = suggestEntityDraft("core.Contract", { flowTemplateIds: ["contract", "metadataOnly"] })
    expect(draft?.source).toBe("heuristic")
    expect(draft?.identity.id).toBe("contract")
    expect(draft?.flowTemplateId).toBe("contract")
    expect(draft?.tables).toHaveLength(1)
    expect(draft?.tables[0]?.name).toBe("core.Contract")
    expect(draft?.tables[0]?.scope).toEqual({ kind: "rootPk", column: "contractId" })
  })

  it("walks FK graph when catalog is available", () => {
    const draft = suggestEntityDraft("core.Dataset", {
      catalog: datasetCatalog,
      flowTemplateIds: ["dataset", "metadataOnly"],
    })
    expect(draft?.source).toBe("catalog")
    expect(draft?.identity).toMatchObject({
      id: "dataset",
      idColumn: "datasetId",
      labelColumn: "name",
      selfJoinColumn: "parentDatasetId",
    })
    expect(draft?.flowTemplateId).toBe("dataset")
    const names = draft?.tables.map((table) => table.name) ?? []
    expect(names).toContain("core.Dataset")
    expect(names).toContain("core.Pipeline")
    expect(names).toContain("core.DatasetColumn")
    const pipeline = draft?.tables.find((table) => table.name === "core.Pipeline")
    expect(pipeline?.scope).toEqual({ kind: "rootPk", column: "datasetId" })
  })
})

describe("suggestEntityTable", () => {
  const root = { rootTable: "core.Dataset", idColumn: "datasetId" }

  it("fills root PK scope for the entity root table", () => {
    const suggestion = suggestEntityTable("core.Dataset", root, { executionOrder: 2 })
    expect(suggestion?.table.scope).toEqual({ kind: "rootPk", column: "datasetId" })
    expect(suggestion?.table.executionOrder).toBe(2)
    expect(suggestion?.table.scopeColumn).toBe("datasetId")
  })

  it("derives scope from FK graph for related tables", () => {
    const suggestion = suggestEntityTable("core.Pipeline", root, {
      catalog: datasetCatalog,
      executionOrder: 3,
    })
    expect(suggestion?.source).toBe("catalog")
    expect(suggestion?.table.scope).toEqual({ kind: "rootPk", column: "datasetId" })
    expect(suggestion?.table.source).toBe("fk-only")
  })

  it("normalizes unqualified table names", () => {
    const suggestion = suggestEntityTable("Pipeline", root, { catalog: datasetCatalog })
    expect(suggestion?.table.name).toBe("core.Pipeline")
  })

  it("returns a status note without mutating table fields when no catalog is loaded", () => {
    const suggestion = suggestEntityTable("core.Contra", root, { executionOrder: 2 })
    expect(suggestion?.source).toBe("heuristic")
    expect(suggestion?.note).toMatch(/schema catalog/i)
    expect(suggestion?.table.note).toBeNull()
    expect(suggestion?.table.scope).toEqual({ kind: "rootPk", column: "" })
  })
})
