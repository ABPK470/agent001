import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { emptyChangeSet } from "../../domain/diff-engine/change-set.js"
import { ENTITY_SPECS } from "../../test-support/entity-fixtures.js"
import { createSyncTestProject, drainTempSyncProjects } from "../../test-support/sync-test-host.js"

const diffTableMock = vi.fn()
const fetchEntityDisplayNameMock = vi.fn()
const fetchPkColumnsMock = vi.fn()
const detectCatalogDriftMock = vi.fn()
const evaluateRootParentMock = vi.fn()
const savePlanMock = vi.fn()

vi.mock("../diff-engine/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../diff-engine/index.js")>()
  return {
    ...actual,
    diffTable: (...args: unknown[]) => diffTableMock(...args)
  }
})

vi.mock("./search.js", () => ({
  fetchEntityDisplayName: (...args: unknown[]) => fetchEntityDisplayNameMock(...args),
  expandTreeIds: vi.fn().mockResolvedValue(null)
}))

vi.mock("./apply.js", () => ({
  fetchPkColumns: (...args: unknown[]) => fetchPkColumnsMock(...args)
}))

vi.mock("../../runtime/catalog-drift.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../runtime/catalog-drift.js")>()
  return {
    ...actual,
    detectCatalogDrift: (...args: unknown[]) => detectCatalogDriftMock(...args),
    // Preview calls this before diffing; return empty column maps so tests stay unit-scoped.
    fetchTableColumnNamesMap: vi.fn().mockResolvedValue(new Map()),
  }
})

vi.mock("./root-parent-preflight.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./root-parent-preflight.js")>()
  return {
    ...actual,
    evaluateRootParentPreflight: (...args: unknown[]) => evaluateRootParentMock(...args)
  }
})

vi.mock("../plan-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plan-store.js")>()
  return {
    ...actual,
    savePlan: (...args: unknown[]) => savePlanMock(...args)
  }
})

import { previewSync } from "./preview.js"

afterEach(() => {
  drainTempSyncProjects()
})

function mockTableResult(table: string, movement: { insert?: number; update?: number; delete?: number }) {
  const changeSet = {
    insert: Array.from({ length: movement.insert ?? 0 }, (_, i) => ({
      pk: String(i + 1),
      values: { id: i + 1 }
    })),
    update: Array.from({ length: movement.update ?? 0 }, (_, i) => ({
      pk: String(i + 100),
      values: { id: i + 100 }
    })),
    delete: Array.from({ length: movement.delete ?? 0 }, (_, i) => ({
      pk: String(i + 200),
      values: { id: i + 200 }
    }))
  }
  return {
    table,
    scopePredicate: "x = 1",
    stats: { unchanged: 5, lowConfidence: 0 },
    changeSet,
    samples: { insert: [], update: [], delete: [] },
    conflicts: [],
    warnings: [],
    diffDurationMs: 3
  }
}

describe("previewSync orchestration", () => {
  let project: ReturnType<typeof createSyncTestProject>

  beforeEach(() => {
    vi.clearAllMocks()
    project = createSyncTestProject(["contract", "dataset", "rule", "pipelineActivity"])
    fetchEntityDisplayNameMock.mockResolvedValue("Test Entity")
    fetchPkColumnsMock.mockResolvedValue(new Map())
    detectCatalogDriftMock.mockResolvedValue({ catalogCompatible: true, issues: [] })
    evaluateRootParentMock.mockResolvedValue({
      ready: true,
      issue: null,
      details: { rootTable: "core.Contract" }
    })
    savePlanMock.mockImplementation((host, plan) => {
      host.sync.plans.memCache.set(plan.planId, plan)
    })
  })

  it("builds and persists a contract preview plan", async () => {
    const spec = ENTITY_SPECS.contract
    diffTableMock.mockImplementation(async (_host, tableDef) =>
      mockTableResult(tableDef.name, tableDef.name === "core.Pipeline" ? { insert: 2 } : {})
    )

    const plan = await previewSync({
      host: project.host,
      entityType: "contract",
      entityId: 4368,
      source: "DEV",
      target: "UAT"
    })

    expect(plan.entity.type).toBe("contract")
    expect(plan.entity.id).toBe(4368)
    expect(plan.source).toBe("DEV")
    expect(plan.target).toBe("UAT")
    expect(plan.tables.length).toBe(spec.tables.filter((t) => !t.userControllable).length)
    expect(plan.totals.insert).toBe(2)
    expect(plan.preflight.catalogCompatible).toBe(true)
    expect(plan.preflight.rootParentReady).toBe(true)
    expect(savePlanMock).toHaveBeenCalledOnce()
    expect(plan.decisionLog?.some((d) => d.id === "root-parent-preflight")).toBe(true)
  })

  it("surfaces root-parent warning when preflight is not ready", async () => {
    diffTableMock.mockImplementation(async (_host, tableDef) =>
      mockTableResult(tableDef.name, tableDef.name === "core.Pipeline" ? { insert: 1 } : {})
    )
    evaluateRootParentMock.mockResolvedValue({
      ready: false,
      issue: "Root row core.Contract contractId=99 missing on target",
      details: { rootTable: "core.Contract", rootKeyColumn: "contractId" }
    })

    const plan = await previewSync({
      host: project.host,
      entityType: "contract",
      entityId: 99,
      source: "DEV",
      target: "UAT"
    })

    expect(plan.preflight.rootParentReady).toBe(false)
    expect(plan.warnings.some((w) => w.includes("[preflight]"))).toBe(true)
    const entry = plan.decisionLog?.find((d) => d.id === "root-parent-preflight")
    expect(entry?.severity).toBe("error")
  })

  it("excludes optional FK-only tables unless explicitly enabled", async () => {
    diffTableMock.mockImplementation(async (_host, tableDef) => mockTableResult(tableDef.name, {}))

    const withoutOptional = await previewSync({
      host: project.host,
      entityType: "contract",
      entityId: 1,
      source: "DEV",
      target: "UAT"
    })
    expect(withoutOptional.tables.some((t) => t.table === "core.Step")).toBe(false)
    expect(withoutOptional.warnings.some((w) => w.includes("FK-only tables excluded"))).toBe(true)

    diffTableMock.mockClear()
    const withOptional = await previewSync({
      host: project.host,
      entityType: "contract",
      entityId: 1,
      source: "DEV",
      target: "UAT",
      enabledOptionalTables: ["core.Step"]
    })
    expect(withOptional.tables.some((t) => t.table === "core.Step")).toBe(true)
    expect(diffTableMock.mock.calls.some((c) => c[1]?.name === "core.Step")).toBe(true)
  })

  it("records catalog drift issues as warnings without throwing", async () => {
    diffTableMock.mockImplementation(async (_host, tableDef) => mockTableResult(tableDef.name, {}))
    detectCatalogDriftMock.mockResolvedValue({
      catalogCompatible: false,
      issues: ["column mismatch on core.Pipeline"]
    })

    const plan = await previewSync({
      host: project.host,
      entityType: "contract",
      entityId: 1,
      source: "DEV",
      target: "UAT"
    })

    expect(plan.preflight.catalogCompatible).toBe(false)
    expect(plan.warnings.some((w) => w.includes("[drift]"))).toBe(true)
  })

  it("tolerates per-table diff failures and marks preview incomplete", async () => {
    diffTableMock.mockImplementation(async (_host, tableDef) => {
      if (tableDef.name === "core.Dataset") throw new Error("connection closed")
      return mockTableResult(tableDef.name, {})
    })

    const plan = await previewSync({
      host: project.host,
      entityType: "contract",
      entityId: 1,
      source: "DEV",
      target: "UAT"
    })

    const failed = plan.tables.find((t) => t.table === "core.Dataset")
    expect(failed?.warnings.some((w) => w.startsWith("Diff failed:"))).toBe(true)
    expect(plan.warnings.some((w) => w.includes("Preview incomplete"))).toBe(true)
    expect(failed?.changeSet).toEqual(emptyChangeSet())
  })

  it("previews dataset entity with self-join expansion path", async () => {
    diffTableMock.mockImplementation(async (_host, tableDef) => mockTableResult(tableDef.name, { update: 1 }))

    const plan = await previewSync({
      host: project.host,
      entityType: "dataset",
      entityId: 55,
      source: "DEV",
      target: "UAT"
    })

    expect(plan.entity.type).toBe("dataset")
    expect(plan.executionContract.metadata.rootTable).toBe("core.Dataset")
    expect(plan.totals.update).toBeGreaterThan(0)
  })

  it("previews pipelineActivity across pipeline and activity tables", async () => {
    diffTableMock.mockImplementation(async (_host, tableDef) => mockTableResult(tableDef.name, { insert: 1 }))

    const plan = await previewSync({
      host: project.host,
      entityType: "pipelineActivity",
      entityId: 700,
      source: "DEV",
      target: "UAT"
    })

    expect(plan.tables).toHaveLength(2)
    expect(plan.tables.map((table) => table.table)).toEqual(["core.Pipeline", "core.Activity"])
    expect(plan.totals.insert).toBe(2)
  })

  it("rejects target-only environment as source", async () => {
    const host = project.host
    const dev = host.sync.environments.items.get("DEV")!
    host.sync.environments.items.set(
      "DEV",
      { ...dev, role: "target" as const }
    )
    await expect(
      previewSync({
        host,
        entityType: "contract",
        entityId: 1,
        source: "DEV",
        target: "UAT"
      })
    ).rejects.toThrow(/target-only/)
  })
})
