/**
 * Cross-entity preview + execute scenario matrix.
 * Exercises root-parent preflight across entity topologies and source/target pairs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { trackedQuery } from "./db-helpers.js"
import { evaluateRootParentPreflight } from "./root-parent-preflight.js"
import {
  buildEntityPlan,
  changeSetRow,
  contractChildUpsertWithoutParent,
  contractRootInsertWithChild,
  tableRow
} from "../../test-support/plan-fixtures.js"
import { ENTITY_SPECS } from "../../test-support/entity-fixtures.js"
import { drainTempSyncProjects } from "../../test-support/sync-test-host.js"

vi.mock("./db-helpers.js", () => ({
  qtable: (name: string) => name,
  trackedQuery: vi.fn()
}))

afterEach(() => {
  drainTempSyncProjects()
})

type Scenario = {
  id: string
  entityType: string
  entityId: number
  source: string
  target: string
  childTable: string
  rootExistsOnTarget: boolean
  includesRootInsert: boolean
  expectReady: boolean
}

const MATRIX: Scenario[] = [
  {
    id: "contract-dev-uat-child-only-missing-root",
    entityType: "contract",
    entityId: 4368,
    source: "DEV",
    target: "UAT",
    childTable: "core.Pipeline",
    rootExistsOnTarget: false,
    includesRootInsert: false,
    expectReady: false
  },
  {
    id: "contract-dev-uat-root-insert-plus-child",
    entityType: "contract",
    entityId: 4368,
    source: "DEV",
    target: "UAT",
    childTable: "core.Pipeline",
    rootExistsOnTarget: false,
    includesRootInsert: true,
    expectReady: true
  },
  {
    id: "contract-dev-uat-child-existing-root",
    entityType: "contract",
    entityId: 99,
    source: "DEV",
    target: "UAT",
    childTable: "core.Dataset",
    rootExistsOnTarget: true,
    includesRootInsert: false,
    expectReady: true
  },
  {
    id: "dataset-dev-uat-column-without-root",
    entityType: "dataset",
    entityId: 55,
    source: "DEV",
    target: "UAT",
    childTable: "core.DatasetColumn",
    rootExistsOnTarget: false,
    includesRootInsert: false,
    expectReady: false
  },
  {
    id: "dataset-dev-prod-with-root-insert",
    entityType: "dataset",
    entityId: 77,
    source: "DEV",
    target: "PROD",
    childTable: "core.DatasetMapping",
    rootExistsOnTarget: false,
    includesRootInsert: true,
    expectReady: true
  },
  {
    id: "rule-dev-uat-rulecolumn-missing-root",
    entityType: "rule",
    entityId: 12,
    source: "DEV",
    target: "UAT",
    childTable: "core.RuleColumn",
    rootExistsOnTarget: false,
    includesRootInsert: false,
    expectReady: false
  },
  {
    id: "pipelineActivity-dev-uat-standalone",
    entityType: "pipelineActivity",
    entityId: 501,
    source: "DEV",
    target: "UAT",
    childTable: "core.Activity",
    rootExistsOnTarget: false,
    includesRootInsert: true,
    expectReady: true
  },
  {
    id: "content-gate-schema-root-only",
    entityType: "content",
    entityId: 3,
    source: "DEV",
    target: "UAT",
    childTable: "gate.Content",
    rootExistsOnTarget: true,
    includesRootInsert: false,
    expectReady: true
  }
]

function planForScenario(s: Scenario) {
  const spec = ENTITY_SPECS[s.entityType]!
  const tables = []
  if (s.includesRootInsert) {
    tables.push(
      tableRow(spec.rootTable, `${spec.idColumn} = ${s.entityId}`, {
        insert: [changeSetRow(String(s.entityId), { [spec.idColumn]: s.entityId })],
        update: [],
        delete: []
      })
    )
  }
  if (s.childTable !== spec.rootTable || !s.includesRootInsert) {
    tables.push(
      tableRow(s.childTable, `${spec.idColumn} = ${s.entityId}`, {
        insert: [changeSetRow("child-1", { id: 1 })],
        update: [],
        delete: []
      })
    )
  }
  return buildEntityPlan({
    entityType: s.entityType,
    entityId: s.entityId,
    source: s.source,
    target: s.target,
    spec,
    tables
  })
}

describe("preview-execute scenario matrix (root-parent)", () => {
  const trackedQueryMock = vi.mocked(trackedQuery)

  beforeEach(() => {
    vi.clearAllMocks()
  })

  for (const scenario of MATRIX) {
    it(`${scenario.id}: ready=${scenario.expectReady}`, async () => {
      trackedQueryMock.mockResolvedValue({
        recordset: scenario.rootExistsOnTarget ? [{ ok: 1 }] : []
      } as never)
      const plan = planForScenario(scenario)
      const result = await evaluateRootParentPreflight({} as never, scenario.target, plan)
      expect(result.ready).toBe(scenario.expectReady)
      if (!scenario.expectReady) {
        expect(result.issue).toContain(ENTITY_SPECS[scenario.entityType]!.rootTable)
      }
    })
  }
})

describe("fixture plans for execute gate snapshots", () => {
  it("contractChildUpsertWithoutParent blocks execute semantics", () => {
    const plan = contractChildUpsertWithoutParent(4368)
    expect(plan.preflight.rootParentReady).toBe(false)
    expect(plan.tables.some((t) => t.table === "core.Pipeline")).toBe(true)
    expect(plan.tables.every((t) => t.table !== "core.Contract" || t.changeSet.insert.length === 0)).toBe(true)
  })

  it("contractRootInsertWithChild is structurally executable", () => {
    const plan = contractRootInsertWithChild(4368)
    expect(plan.preflight.rootParentReady).toBe(true)
    const root = plan.tables.find((t) => t.table === "core.Contract")
    expect(root?.changeSet.insert.length).toBeGreaterThan(0)
  })
})
