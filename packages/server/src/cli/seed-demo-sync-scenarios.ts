/**
 * Demo sync / pipeline history builders — event sequences aligned with deploy catalog.
 */

import { randomUUID } from "node:crypto"
import { EventType, SyncRunStatus } from "@mia/shared-enums"
import type { SyncPlan } from "../../../sync/src/domain/plan.js"
import {
  buildEntityPlan,
  changeSetRow,
  tableRow,
} from "../../../sync/src/test-support/plan-fixtures.js"
import { ENTITY_SPECS } from "../../../sync/src/test-support/entity-fixtures.js"

export const DEMO_SYNC_PLAN_PREFIX = "demo-sync-"

export type DemoSyncPhase = "preview" | "execute"

export type DemoSyncScenario = {
  planId: string
  entityType: keyof typeof ENTITY_SPECS
  entityId: number
  displayName: string
  source: string
  target: string
  previewTotals: { insert: number; update: number; delete: number }
  executeTotals?: { insert: number; update: number; delete: number }
  status: typeof SyncRunStatus.Preview | typeof SyncRunStatus.Success | typeof SyncRunStatus.Failed
  executeSteps?: readonly string[]
  metadataTables?: readonly string[]
  previewTables?: readonly string[]
  error?: string
  failedStep?: string
  failedTable?: string
  startedOffsetMs: number
  durationMs: number
}

type SeedEvent = {
  type: string
  atOffsetMs: number
  data: Record<string, unknown>
}

export const DEMO_SYNC_SCENARIOS: DemoSyncScenario[] = [
  {
    planId: `${DEMO_SYNC_PLAN_PREFIX}contract-uat`,
    entityType: "contract",
    entityId: 4539,
    displayName: "AccountClientMapping",
    source: "dev",
    target: "uat",
    previewTotals: { insert: 3, update: 1, delete: 0 },
    executeTotals: { insert: 3, update: 1, delete: 0 },
    status: SyncRunStatus.Success,
    previewTables: ["core.Contract", "core.ContractColumn", "core.Dataset"],
    metadataTables: ["core.Contract", "core.ContractColumn", "core.Dataset"],
    executeSteps: [
      "auditCheck",
      "targetLock",
      "metadataSync",
      "pipelineRegister",
      "contractUndeploy",
      "contractCreateDatasetStage",
      "syncDate",
    ],
    startedOffsetMs: -720_000,
    durationMs: 42_000,
  },
  {
    planId: `${DEMO_SYNC_PLAN_PREFIX}dataset-preview`,
    entityType: "dataset",
    entityId: 6374,
    displayName: "agent.vPipelineRunContract",
    source: "dev",
    target: "uat",
    previewTotals: { insert: 0, update: 2, delete: 0 },
    status: SyncRunStatus.Preview,
    previewTables: ["core.Dataset", "core.Pipeline"],
    startedOffsetMs: -540_000,
    durationMs: 8_500,
  },
  {
    planId: `${DEMO_SYNC_PLAN_PREFIX}pipeline-register`,
    entityType: "pipelineActivity",
    entityId: 1201,
    displayName: "ETL.DailyLoad",
    source: "dev",
    target: "uat",
    previewTotals: { insert: 1, update: 0, delete: 0 },
    executeTotals: { insert: 1, update: 0, delete: 0 },
    status: SyncRunStatus.Success,
    previewTables: ["core.Pipeline", "core.Activity"],
    metadataTables: ["core.Pipeline", "core.Activity"],
    executeSteps: ["metadataSync", "pipelineRegister"],
    startedOffsetMs: -420_000,
    durationMs: 11_500,
  },
  {
    planId: `${DEMO_SYNC_PLAN_PREFIX}contract-fail`,
    entityType: "contract",
    entityId: 5128,
    displayName: "ACSRawTest",
    source: "uat",
    target: "dev",
    previewTotals: { insert: 1, update: 0, delete: 0 },
    executeTotals: { insert: 0, update: 0, delete: 0 },
    status: SyncRunStatus.Failed,
    previewTables: ["core.Contract", "core.DatasetMapping"],
    metadataTables: ["core.ContractColumn", "core.DatasetMapping"],
    executeSteps: ["auditCheck", "targetLock", "metadataSync"],
    failedStep: "metadataSync",
    failedTable: "core.DatasetMapping",
    error: "metadataSync / upsert / core.DatasetMapping failed: FK constraint",
    startedOffsetMs: -300_000,
    durationMs: 18_200,
  },
  {
    planId: `${DEMO_SYNC_PLAN_PREFIX}rule-metadata`,
    entityType: "rule",
    entityId: 88,
    displayName: "ValidationRule.Core",
    source: "dev",
    target: "uat",
    previewTotals: { insert: 0, update: 1, delete: 0 },
    executeTotals: { insert: 0, update: 1, delete: 0 },
    status: SyncRunStatus.Success,
    previewTables: ["core.Rule", "core.RuleColumn"],
    metadataTables: ["core.Rule", "core.RuleColumn"],
    executeSteps: ["metadataSync", "syncDate"],
    startedOffsetMs: -180_000,
    durationMs: 6_400,
  },
  {
    planId: `${DEMO_SYNC_PLAN_PREFIX}dataset-prod`,
    entityType: "dataset",
    entityId: 6374,
    displayName: "agent.vPipelineRunContract",
    source: "uat",
    target: "prod",
    previewTotals: { insert: 0, update: 2, delete: 0 },
    executeTotals: { insert: 0, update: 2, delete: 0 },
    status: SyncRunStatus.Success,
    previewTables: ["core.Dataset", "core.Pipeline"],
    metadataTables: ["core.Dataset", "core.Pipeline"],
    executeSteps: ["metadataSync", "datasetDeploy", "syncDate"],
    startedOffsetMs: -90_000,
    durationMs: 24_800,
  },
]

export function buildDemoSyncPlan(scenario: DemoSyncScenario): SyncPlan {
  const spec = ENTITY_SPECS[scenario.entityType]
  const tables = (scenario.metadataTables ?? scenario.previewTables ?? spec.executionOrder.slice(0, 2)).map(
    (table, index) => {
      const insert = index === 0 ? scenario.previewTotals.insert : 0
      const update = index === 0 ? scenario.previewTotals.update : Math.min(scenario.previewTotals.update, 1)
      const del = index === 0 ? scenario.previewTotals.delete : 0
      return tableRow(
        table,
        `${spec.idColumn} = ${scenario.entityId}`,
        {
          insert: insert > 0 ? [changeSetRow(String(scenario.entityId + index), { [spec.idColumn]: scenario.entityId })] : [],
          update: update > 0 ? [changeSetRow(String(scenario.entityId + index), { [spec.idColumn]: scenario.entityId })] : [],
          delete: del > 0 ? [changeSetRow(String(scenario.entityId + index), { [spec.idColumn]: scenario.entityId })] : [],
        },
        { stats: { unchanged: 12 + index * 3 } },
      )
    },
  )

  const plan = buildEntityPlan({
    planId: scenario.planId,
    entityType: scenario.entityType,
    entityId: scenario.entityId,
    source: scenario.source.toUpperCase(),
    target: scenario.target.toUpperCase(),
    spec,
    tables,
    createdAtMs: Date.now() + scenario.startedOffsetMs,
  })

  plan.entity.displayName = scenario.displayName
  plan.source = scenario.source
  plan.target = scenario.target
  plan.totals = {
    ...plan.totals,
    insert: scenario.previewTotals.insert,
    update: scenario.previewTotals.update,
    delete: scenario.previewTotals.delete,
    tablesCount: tables.length,
  }
  plan.decisionLog = [
    {
      id: `definition-${scenario.entityType}`,
      recordedAt: new Date(Date.now() + scenario.startedOffsetMs).toISOString(),
      stage: "preview",
      category: "definition",
      severity: "info",
      title: "Published definition selected",
      summary: `Using published definition ${scenario.entityType}@demo.`,
    },
  ]
  return plan
}

export function buildDemoSyncEvents(
  scenario: DemoSyncScenario,
  actorUpn: string,
  baseMs: number,
): SeedEvent[] {
  const events: SeedEvent[] = []
  const previewId = randomUUID()
  const common = {
    planId: scenario.planId,
    actorUpn,
    entityType: scenario.entityType,
    entityId: scenario.entityId,
    entityDisplayName: scenario.displayName,
    source: scenario.source,
    target: scenario.target,
  }

  let t = scenario.startedOffsetMs

  events.push({
    type: EventType.SyncPreviewStarted,
    atOffsetMs: t,
    data: { ...common, previewId, force: false },
  })
  t += 800

  for (const [index, table] of (scenario.previewTables ?? []).entries()) {
    events.push({
      type: EventType.SyncPreviewTableStart,
      atOffsetMs: t,
      data: { previewId, planId: scenario.planId, table, actorUpn },
    })
    t += 400 + index * 120
    events.push({
      type: EventType.SyncPreviewTableDone,
      atOffsetMs: t,
      data: {
        previewId,
        planId: scenario.planId,
        table,
        actorUpn,
        insert: index === 0 ? scenario.previewTotals.insert : 0,
        update: index === 0 ? scenario.previewTotals.update : 0,
        delete: index === 0 ? scenario.previewTotals.delete : 0,
        durationMs: 900 + index * 200,
      },
    })
    t += 200
  }

  events.push({
    type: EventType.SyncPreviewCompleted,
    atOffsetMs: t,
    data: {
      ...common,
      previewId,
      totals: scenario.previewTotals,
      durationMs: Math.min(scenario.durationMs, 12_000),
    },
  })
  t += 600

  if (scenario.status === SyncRunStatus.Preview) return events

  events.push({
    type: EventType.SyncExecuteStarted,
    atOffsetMs: t,
    data: { ...common },
  })
  t += 500

  for (const step of scenario.executeSteps ?? []) {
    events.push({
      type: EventType.SyncExecuteStep,
      atOffsetMs: t,
      data: { planId: scenario.planId, actorUpn, step },
    })
    t += 350

    if (step === "metadataSync") {
      for (const [index, table] of (scenario.metadataTables ?? []).entries()) {
        events.push({
          type: EventType.SyncExecuteTableStart,
          atOffsetMs: t,
          data: {
            planId: scenario.planId,
            actorUpn,
            table,
            op: "upsert",
            rowsTotal: 1 + index,
          },
        })
        t += 280
        if (scenario.status === SyncRunStatus.Failed && table === scenario.failedTable) {
          events.push({
            type: EventType.SyncExecuteStepFailed,
            atOffsetMs: t,
            data: {
              planId: scenario.planId,
              actorUpn,
              step,
              table,
              op: "upsert",
              error: scenario.error ?? "step failed",
            },
          })
          t += 120
          events.push({
            type: EventType.SyncExecuteFailed,
            atOffsetMs: t,
            data: {
              planId: scenario.planId,
              actorUpn,
              step: scenario.failedStep ?? step,
              table: scenario.failedTable ?? table,
              error: scenario.error ?? "execute failed",
            },
          })
          return events
        }
        events.push({
          type: EventType.SyncExecuteTableDone,
          atOffsetMs: t,
          data: {
            planId: scenario.planId,
            actorUpn,
            table,
            op: "upsert",
            rowsApplied: 1 + index,
            durationMs: 420 + index * 80,
          },
        })
        t += 180
      }
    }
  }

  if (scenario.status === SyncRunStatus.Success) {
    events.push({
      type: EventType.SyncExecuteCompleted,
      atOffsetMs: scenario.startedOffsetMs + scenario.durationMs,
      data: {
        ...common,
        applied: scenario.executeTotals ?? scenario.previewTotals,
        durationMs: scenario.durationMs,
      },
    })
  }

  return events
}

export function demoSyncIso(baseMs: number, offsetMs: number): string {
  return new Date(baseMs + offsetMs).toISOString()
}
