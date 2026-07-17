import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SyncPlan } from "../plan-store.js"
import { trackedQuery } from "./db-helpers.js"
import {
  entityIdMatches,
  evaluateRootParentPreflight,
  planInsertsRootEntity,
  planRequiresRootOnTarget
} from "./root-parent-preflight.js"

vi.mock("./db-helpers.js", () => ({
  qtable: (name: string) => name,
  trackedQuery: vi.fn()
}))

function makePlan(overrides: {
  entityType?: string
  entityId?: string | number
  rootTable?: string
  rootKeyColumn?: string
  recipeTables?: string[]
  tableRows?: SyncPlan["tables"]
}): SyncPlan {
  const rootTable = overrides.rootTable ?? "core.Contract"
  const rootKeyColumn = overrides.rootKeyColumn ?? "contractId"
  const recipeNames = overrides.recipeTables ?? [rootTable, "core.Pipeline"]
  return {
    entity: { type: overrides.entityType ?? "contract", id: overrides.entityId ?? 4368 },
    executionContract: {
      metadata: {
        rootTable,
        rootKeyColumn,
        tables: recipeNames.map((name) => ({
          name,
          scopeColumn: name === rootTable ? rootKeyColumn : "contractId",
          predicate: `${rootKeyColumn} = {id}`
        })),
        executionOrder: recipeNames,
        reverseOrder: [...recipeNames].reverse()
      }
    },
    tables: overrides.tableRows ?? []
  } as unknown as SyncPlan
}

describe("root-parent preflight (pure)", () => {
  it("entityIdMatches compares numeric strings and numbers", () => {
    expect(entityIdMatches(4368, "4368")).toBe(true)
    expect(entityIdMatches("4368", 4368)).toBe(true)
    expect(entityIdMatches(4368, 4369)).toBe(false)
  })

  it("does not require root when only root table has work", () => {
    const plan = makePlan({
      tableRows: [
        {
          table: "core.Contract",
          changeSet: { insert: [{ pk: "4368", values: { contractId: 4368 } }], update: [], delete: [] }
        } as never
      ]
    })
    expect(planRequiresRootOnTarget(plan)).toBe(false)
    expect(planInsertsRootEntity(plan)).toBe(true)
  })

  it("requires root when a recipe child has upsert work", () => {
    const plan = makePlan({
      tableRows: [
        {
          table: "core.Pipeline",
          changeSet: { insert: [{ pk: "9", values: { pipelineId: 9, contractId: 4368 } }], update: [], delete: [] }
        } as never
      ]
    })
    expect(planRequiresRootOnTarget(plan)).toBe(true)
    expect(planInsertsRootEntity(plan)).toBe(false)
  })

  it("detects planned root insert for dataset entity", () => {
    const plan = makePlan({
      entityType: "dataset",
      entityId: 100,
      rootTable: "core.Dataset",
      rootKeyColumn: "datasetId",
      recipeTables: ["core.Dataset", "core.DatasetColumn"],
      tableRows: [
        {
          table: "core.Dataset",
          changeSet: { insert: [{ pk: "100", values: { datasetId: 100 } }], update: [], delete: [] }
        } as never,
        {
          table: "core.DatasetColumn",
          changeSet: { insert: [{ pk: "1", values: { datasetColumnId: 1 } }], update: [], delete: [] }
        } as never
      ]
    })
    expect(planRequiresRootOnTarget(plan)).toBe(true)
    expect(planInsertsRootEntity(plan)).toBe(true)
  })
})

describe("evaluateRootParentPreflight", () => {
  const trackedQueryMock = vi.mocked(trackedQuery)

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("is ready when child upserts exist and root insert is planned", async () => {
    const plan = makePlan({
      tableRows: [
        {
          table: "core.Contract",
          changeSet: { insert: [{ pk: "4368", values: { contractId: 4368 } }], update: [], delete: [] }
        } as never,
        {
          table: "core.Pipeline",
          changeSet: { insert: [{ pk: "9", values: { pipelineId: 9 } }], update: [], delete: [] }
        } as never
      ]
    })

    const result = await evaluateRootParentPreflight({} as never, "TARGET", plan)
    expect(result.ready).toBe(true)
    expect(trackedQueryMock).not.toHaveBeenCalled()
  })

  it("is not ready when child upserts exist, root missing on target, no root insert", async () => {
    trackedQueryMock.mockResolvedValue({ recordset: [] } as never)
    const plan = makePlan({
      tableRows: [
        {
          table: "core.Pipeline",
          changeSet: { insert: [{ pk: "9", values: { pipelineId: 9 } }], update: [], delete: [] }
        } as never
      ]
    })

    const result = await evaluateRootParentPreflight({} as never, "TARGET", plan)
    expect(result.ready).toBe(false)
    expect(result.issue).toContain("core.Contract")
    expect(result.issue).toContain("contractId=4368")
    expect(trackedQueryMock).toHaveBeenCalledWith(
      {} as never,
      "TARGET",
      expect.stringContaining("core.Contract"),
      "rootParent.exists(core.Contract)"
    )
  })

  it("is ready when root exists on target", async () => {
    trackedQueryMock.mockResolvedValue({ recordset: [{ ok: 1 }] } as never)
    const plan = makePlan({
      tableRows: [
        {
          table: "core.Pipeline",
          changeSet: { insert: [{ pk: "9", values: { pipelineId: 9 } }], update: [], delete: [] }
        } as never
      ]
    })

    const result = await evaluateRootParentPreflight({} as never, "TARGET", plan)
    expect(result.ready).toBe(true)
  })

  it("uses dataset root metadata from execution contract", async () => {
    trackedQueryMock.mockResolvedValue({ recordset: [] } as never)
    const plan = makePlan({
      entityType: "dataset",
      entityId: 55,
      rootTable: "core.Dataset",
      rootKeyColumn: "datasetId",
      recipeTables: ["core.Dataset", "core.DatasetColumn"],
      tableRows: [
        {
          table: "core.DatasetColumn",
          changeSet: { insert: [{ pk: "1", values: { datasetColumnId: 1 } }], update: [], delete: [] }
        } as never
      ]
    })

    const result = await evaluateRootParentPreflight({} as never, "TARGET", plan)
    expect(result.ready).toBe(false)
    expect(result.issue).toContain("core.Dataset")
    expect(result.issue).toContain("datasetId=55")
    expect(trackedQueryMock.mock.calls[0]?.[2]).toContain("core.Dataset")
    expect(trackedQueryMock.mock.calls[0]?.[2]).toContain("datasetId")
  })
})
