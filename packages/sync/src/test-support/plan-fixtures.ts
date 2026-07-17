/**
 * Shared SyncPlan builders for orchestrator / diff-engine tests.
 */

import type { SyncPlan, SyncPlanChangeSet, SyncPlanTable } from "../domain/plan.js"
import { loadDeployFlowCatalogForTests } from "../test-support/test-flow-catalog.js"
import { ENTITY_SPECS, type EntityFixtureSpec } from "./entity-fixtures.js"
import type { AuthoredSyncFlowStep } from "@mia/shared-types"

const EMPTY_CHANGE_SET: SyncPlanChangeSet = { insert: [], update: [], delete: [] }

export function changeSetRow(
  pk: string,
  values: Record<string, unknown>
): { pk: string; values: Record<string, unknown> } {
  return { pk, values }
}

export function tableRow(
  table: string,
  scopePredicate: string,
  changeSet: SyncPlanChangeSet,
  extras?: Partial<SyncPlanTable>
): SyncPlanTable {
  return {
    table,
    scopePredicate,
    stats: { unchanged: 0, lowConfidence: 0, ...extras?.stats },
    changeSet,
    samples: { insert: [], update: [], delete: [] },
    conflicts: [],
    warnings: [],
    diffDurationMs: 1,
    ...extras
  }
}

export interface BuildPlanOptions {
  planId?: string
  entityType: string
  entityId: string | number
  source?: string
  target?: string
  spec: EntityFixtureSpec
  tables?: SyncPlanTable[]
  preflight?: SyncPlan["preflight"]
  warnings?: string[]
  createdAtMs?: number
}

export function buildEntityPlan(options: BuildPlanOptions): SyncPlan {
  const {
    planId = "plan-test-1",
    entityType,
    entityId,
    source = "DEV",
    target = "UAT",
    spec,
    tables = [],
    preflight = {
      catalogCompatible: true,
      issues: [],
      rootParentReady: true,
      rootParentIssue: null
    },
    warnings = [],
    createdAtMs = Date.now()
  } = options

  const recipeTables = spec.tables.map((t) => ({
    name: t.name,
    scopeColumn: t.scopeColumn,
    predicate: t.predicate
  }))

  const flowSteps: AuthoredSyncFlowStep[] = [
    {
      id: "metadataSync",
      phase: "metadata",
      kind: "metadataSync",
      title: "Metadata sync",
      description: "Apply metadata changeSet",
      objectName: null,
      auditObjectType: null,
      pipelineName: null,
    },
  ]

  return {
    planId,
    createdAt: new Date(createdAtMs).toISOString(),
    createdAtMs,
    entity: { type: entityType as never, id: entityId, displayName: `${entityType} ${entityId}` },
    source,
    target,
    preflight,
    tables,
    totals: {
      insert: tables.reduce((n, t) => n + t.changeSet.insert.length, 0),
      update: tables.reduce((n, t) => n + t.changeSet.update.length, 0),
      delete: tables.reduce((n, t) => n + t.changeSet.delete.length, 0),
      unchanged: tables.reduce((n, t) => n + (t.stats?.unchanged ?? 0), 0),
      lowConfidence: 0,
      conflicts: tables.reduce((n, t) => n + t.conflicts.length, 0),
      tablesCount: tables.length
    },
    dependencyGraph: { nodes: [], edges: [] },
    warnings,
    estimatedDurationSec: 2,
    executionContract: {
      definitionId: entityType,
      definitionPublishedVersion: "test-v1",
      definitionPublishedAt: new Date(0).toISOString(),
      governance: { freezeWindowIds: [] },
      bindings: { serviceProfileRef: "default", environmentPolicyRef: "default" },
      allowedSchemas: ["core"],
      metadata: {
        rootTable: spec.rootTable,
        rootKeyColumn: spec.idColumn,
        selfJoinColumn: spec.selfJoinColumn ?? null,
        tables: recipeTables,
        executionOrder: spec.executionOrder,
        reverseOrder: [...spec.executionOrder].reverse()
      },
      flow: {
        steps: flowSteps,
        catalog: loadDeployFlowCatalogForTests().snapForSteps(flowSteps),
      },
      provenance: { kind: "manual" }
    },
    decisionLog: [],
    governanceDecision: null,
    entityPolicies: null
  }
}

/** Contract child upsert without parent on target — should fail root-parent preflight. */
export function contractChildUpsertWithoutParent(entityId = 4368): SyncPlan {
  const spec = ENTITY_SPECS.contract
  return buildEntityPlan({
    entityType: "contract",
    entityId,
    spec,
    tables: [
      tableRow("core.Pipeline", `contractId = ${entityId}`, {
        ...EMPTY_CHANGE_SET,
        insert: [changeSetRow("99", { pipelineId: 99, contractId: entityId })]
      })
    ],
    preflight: {
      catalogCompatible: true,
      issues: [],
      rootParentReady: false,
      rootParentIssue: "missing parent"
    }
  })
}

/** Contract sync with root insert + child — root-parent should pass. */
export function contractRootInsertWithChild(entityId = 4368): SyncPlan {
  const spec = ENTITY_SPECS.contract
  return buildEntityPlan({
    entityType: "contract",
    entityId,
    spec,
    tables: [
      tableRow("core.Contract", `contractId = ${entityId}`, {
        insert: [changeSetRow(String(entityId), { contractId: entityId })],
        update: [],
        delete: []
      }),
      tableRow("core.Pipeline", `contractId = ${entityId}`, {
        insert: [changeSetRow("99", { pipelineId: 99, contractId: entityId })],
        update: [],
        delete: []
      })
    ]
  })
}

export { EMPTY_CHANGE_SET }
