import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { SyncPlan } from "../plan-store.js"
import { asPlanId } from "../../domain/types/branded-ids.js"
import { withPermissionDefaults } from "../../core/eligibility/environments.js"
import {
  buildEntityPlan,
  contractChildUpsertWithoutParent,
  contractRootInsertWithChild,
  tableRow,
  changeSetRow,
  EMPTY_CHANGE_SET
} from "../../test-support/plan-fixtures.js"
import { ENTITY_SPECS } from "../../test-support/entity-fixtures.js"
import { createSyncTestHost } from "../../test-support/sync-test-host.js"
import type { SyncRuntimeHost } from "../../ports/host.js"

const loadPlanMock = vi.fn<() => SyncPlan | null>()
const planTooOldMock = vi.fn<() => boolean>()
const detectCatalogDriftMock = vi.fn()
const evaluateRootParentMock = vi.fn()
const getPoolMock = vi.fn()
const fetchPkColumnsMock = vi.fn()
const runMetadataSyncMock = vi.fn()
const runPostMetadataMock = vi.fn()

vi.mock("../plan-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plan-store.js")>()
  return {
    ...actual,
    loadPlan: (...args: unknown[]) => loadPlanMock(...(args as [])),
    planTooOldToExecute: (...args: unknown[]) => planTooOldMock(...(args as []))
  }
})

vi.mock("../../runtime/catalog-drift.js", () => ({
  detectCatalogDrift: (...args: unknown[]) => detectCatalogDriftMock(...args)
}))

vi.mock("./gates/root-parent-preflight.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gates/root-parent-preflight.js")>()
  return {
    ...actual,
    evaluateRootParentPreflight: (...args: unknown[]) => evaluateRootParentMock(...args)
  }
})

vi.mock("../../adapters/mssql/connection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../adapters/mssql/connection.js")>()
  return {
    ...actual,
    getPool: (...args: unknown[]) => getPoolMock(...args)
  }
})

vi.mock("./apply.js", () => ({
  fetchPkColumns: (...args: unknown[]) => fetchPkColumnsMock(...args)
}))

vi.mock("./metadata-sync.js", () => ({
  runMetadataSync: (...args: unknown[]) => runMetadataSyncMock(...args)
}))

vi.mock("./post-metadata-pipeline.js", () => ({
  runPostMetadataPipeline: (...args: unknown[]) => runPostMetadataMock(...args)
}))

vi.mock("./archive.js", () => ({
  probeTriggers: vi.fn().mockResolvedValue(new Map())
}))

import { executeSync } from "./execute.js"

function hostWithEnvs(overrides?: {
  sourceRole?: "source" | "target" | "both"
  targetRole?: "source" | "target" | "both"
  targetName?: string
}): SyncRuntimeHost {
  const root = "/tmp/sync-gates-test"
  const host = createSyncTestHost(root)
  const source = withPermissionDefaults({
    name: "DEV",
    connectorId: "DEV",
    displayName: "Dev",
    color: "emerald",
    role: overrides?.sourceRole ?? "both",
    ringOrder: 0,
    allowedSyncEnvironments: ["UAT", "PROD"]
  })
  const target = withPermissionDefaults({
    name: overrides?.targetName ?? "UAT",
    connectorId: overrides?.targetName ?? "UAT",
    displayName: "UAT",
    color: "amber",
    role: overrides?.targetRole ?? "both",
    ringOrder: 1,
    allowedSyncEnvironments: null
  })
  host.sync.environments.items.set("DEV", source)
  host.sync.environments.items.set("UAT", target)
  if (overrides?.targetName === "PROD") {
    host.sync.environments.items.set(
      "PROD",
      withPermissionDefaults({
        name: "PROD",
        connectorId: "PROD",
        displayName: "Prod",
        color: "rose",
        role: "both",
        ringOrder: 2,
        allowedSyncEnvironments: null
      })
    )
  }
  return host
}

function readyPlan(overrides?: Partial<SyncPlan>): SyncPlan {
  const base = contractRootInsertWithChild(100)
  return { ...base, planId: asPlanId("gate-plan"), ...overrides }
}

describe("executeSync pre-execution gates", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    loadPlanMock.mockReturnValue(readyPlan())
    planTooOldMock.mockReturnValue(false)
    detectCatalogDriftMock.mockResolvedValue({ catalogCompatible: true, issues: [] })
    evaluateRootParentMock.mockResolvedValue({ ready: true, issue: null, details: {} })
    fetchPkColumnsMock.mockResolvedValue(new Map())
    getPoolMock.mockResolvedValue({
      pool: { request: () => ({ query: async () => ({ recordset: [] }) }) },
      entry: {},
    })
    runMetadataSyncMock.mockResolvedValue({ applied: { insert: 0, update: 0, delete: 0 } })
    runPostMetadataMock.mockResolvedValue(undefined)
  })

  it("requires confirm=true", async () => {
    const result = await executeSync("gate-plan", { host: hostWithEnvs(), confirm: false })
    expect(result.outcome).toBe("refused")
    expect(result.error).toMatch(/confirm=true/)
  })

  it("refuses missing plan", async () => {
    loadPlanMock.mockReturnValue(null)
    const result = await executeSync("missing", { host: hostWithEnvs(), confirm: true })
    expect(result.outcome).toBe("refused")
    expect(result.error).toMatch(/not found/)
  })

  it("refuses stale plan", async () => {
    planTooOldMock.mockReturnValue(true)
    const result = await executeSync("gate-plan", { host: hostWithEnvs(), confirm: true })
    expect(result.outcome).toBe("refused")
    expect(result.error).toMatch(/older than 1 hour/)
  })

  it("refuses target-only source environment", async () => {
    const result = await executeSync("gate-plan", {
      host: hostWithEnvs({ sourceRole: "target" }),
      confirm: true
    })
    expect(result.outcome).toBe("refused")
    expect(result.error).toMatch(/target-only/)
  })

  it("refuses source-only target environment", async () => {
    const result = await executeSync("gate-plan", {
      host: hostWithEnvs({ targetRole: "source" }),
      confirm: true
    })
    expect(result.outcome).toBe("refused")
    expect(result.error).toMatch(/source-only/)
  })

  it("refuses catalog drift at execute time", async () => {
    detectCatalogDriftMock.mockResolvedValue({
      catalogCompatible: false,
      issues: ["missing column foo"]
    })
    const result = await executeSync("gate-plan", { host: hostWithEnvs(), confirm: true })
    expect(result.outcome).toBe("refused")
    expect(result.error).toMatch(/Catalog drift detected/)
  })

  it("refuses scope misattribution conflicts", async () => {
    const plan = readyPlan({
      tables: [
        tableRow("core.Pipeline", "contractId = 100", EMPTY_CHANGE_SET, {
          conflicts: [
            {
              pk: "9",
              expectedScope: { contractId: 100 },
              actualScope: { contractId: 200 },
              summary: "pipelineId=9 belongs to contractId=200 on target"
            }
          ]
        })
      ]
    })
    loadPlanMock.mockReturnValue(plan)
    const result = await executeSync("gate-plan", { host: hostWithEnvs(), confirm: true })
    expect(result.outcome).toBe("refused")
    expect(result.error).toMatch(/Scope misattribution/)
  })

  it("refuses when root parent is not ready", async () => {
    loadPlanMock.mockReturnValue(contractChildUpsertWithoutParent(200))
    evaluateRootParentMock.mockResolvedValue({
      ready: false,
      issue: "Root row missing on target",
      details: { rootTable: "core.Contract" }
    })
    const result = await executeSync("gate-plan", { host: hostWithEnvs(), confirm: true })
    expect(result.outcome).toBe("refused")
    expect(result.error).toMatch(/Root row missing/)
  })

  it("refuses plan missing execution contract", async () => {
    const plan = readyPlan()
    ;(plan as { executionContract?: unknown }).executionContract = undefined
    loadPlanMock.mockReturnValue(plan)
    const result = await executeSync("gate-plan", { host: hostWithEnvs(), confirm: true })
    expect(result.outcome).toBe("refused")
    expect(result.error).toMatch(/execution contract/)
  })

})

describe("executeSync entity scenarios (gate matrix)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    planTooOldMock.mockReturnValue(false)
    detectCatalogDriftMock.mockResolvedValue({ catalogCompatible: true, issues: [] })
    fetchPkColumnsMock.mockResolvedValue(new Map())
    getPoolMock.mockResolvedValue({
      pool: { request: () => ({ query: async () => ({ recordset: [] }) }) },
      entry: {},
    })
    runMetadataSyncMock.mockResolvedValue({ applied: { insert: 0, update: 0, delete: 0 } })
    runPostMetadataMock.mockResolvedValue({ stepWarnings: [] })
  })

  const scenarios: Array<{
    name: string
    entityType: string
    entityId: number
    childTable: string
    rootReady: boolean
    shouldPassGate: boolean
  }> = [
    { name: "contract child without parent", entityType: "contract", entityId: 1, childTable: "core.Pipeline", rootReady: false, shouldPassGate: false },
    { name: "contract root+child insert", entityType: "contract", entityId: 2, childTable: "core.Pipeline", rootReady: true, shouldPassGate: true },
    { name: "dataset column without parent", entityType: "dataset", entityId: 10, childTable: "core.DatasetColumn", rootReady: false, shouldPassGate: false },
    { name: "rule column without parent", entityType: "rule", entityId: 20, childTable: "core.RuleColumn", rootReady: false, shouldPassGate: false },
    { name: "pipelineActivity standalone", entityType: "pipelineActivity", entityId: 30, childTable: "core.Activity", rootReady: true, shouldPassGate: true }
  ]

  for (const scenario of scenarios) {
    it(`${scenario.name}: root-parent gate ${scenario.shouldPassGate ? "passes" : "blocks"}`, async () => {
      const spec = ENTITY_SPECS[scenario.entityType]!
      const tables =
        scenario.entityType === "pipelineActivity"
          ? [
              tableRow(spec.rootTable, `${spec.idColumn} = ${scenario.entityId}`, {
                insert: [changeSetRow(String(scenario.entityId), { [spec.idColumn]: scenario.entityId })],
                update: [],
                delete: []
              })
            ]
          : [
              tableRow(scenario.childTable, `${spec.idColumn} = ${scenario.entityId}`, {
                insert: [changeSetRow("1", { id: 1 })],
                update: [],
                delete: []
              })
            ]
      const plan = buildEntityPlan({
        entityType: scenario.entityType,
        entityId: scenario.entityId,
        spec,
        tables
      })
      loadPlanMock.mockReturnValue(plan)
      evaluateRootParentMock.mockResolvedValue({
        ready: scenario.rootReady,
        issue: scenario.rootReady ? null : `missing ${spec.rootTable}`,
        details: { rootTable: spec.rootTable }
      })

      if (scenario.shouldPassGate) {
        const result = await executeSync(plan.planId, { host: hostWithEnvs(), confirm: true })
        expect(result.outcome).toBe("completed")
        expect(result.success).toBe(true)
      } else {
        const result = await executeSync(plan.planId, { host: hostWithEnvs(), confirm: true })
        expect(result.outcome).toBe("refused")
        expect(result.error).toMatch(/missing/)
      }
    })
  }
})
