/**
 * `previewSync` — builds a SyncPlan for a given entity by running the
 * diff engine across every recipe table in parallel, validating
 * environments + catalog drift, and persisting the plan.
 *
 * @module
 */

import {
  computePlanTotals,
  movementFromChangeSet,
} from "@mia/shared-types"
import { randomUUID } from "node:crypto"
import { resolvePreviewTableConcurrency } from "../../adapters/mssql/pool-concurrency.js"
import { requirePublishedFlowCatalog } from "../../domain/flow-catalog.js"
import { detectCatalogDrift, fetchTableColumnNamesMap } from "../../runtime/catalog-drift.js"
import { selectDefinitionTables, type SyncEntityId } from "../../domain/definition-selection.js"
import { materializeDefinitionTablesForSchema } from "../../domain/entity-registry/materialize-scd2-for-schema.js"
import { coerceSyncEntityId } from "../../domain/entity-instance-ref.js"
import { buildDependencyGraph, diffTable } from "../diff-engine/index.js"
import { assertSupportedSyncDirection, getEnvironment } from "../../domain/environments.js"
import {
  assertEnvConnectorReady,
} from "../../domain/sync-env-eligibility.js"
import { readyMssqlConnectorIds } from "../connector-readiness.js"
import { evaluateFreezeWindows } from "../../domain/governance/freeze-windows.js"
import { asEntityId, type PlanId } from "../../domain/types/branded-ids.js"
import { getPublishedSyncDefinition } from "../../domain/published-definitions.js"
import { assertPublishedContractCurrent } from "../../domain/publish-readiness.js"
import { instantiatePredicate, instantiatePredicateWithTree } from "../../domain/predicate.js"
import { EventType, SyncOperationType, type SyncRuntimeHost } from "../../ports/index.js"
import { emitSyncEvent as emit, type SyncTelemetryContext } from "../events.js"
import {
  allocPlanId,
  savePlan,
  type SyncPlan,
  type SyncPlanTable,
  type SyncPlanTotals
} from "../plan-store.js"
import { emptyChangeSet } from "../../domain/diff-engine/change-set.js"
import { fetchPkColumns } from "./apply.js"
import { mapWithConcurrency, projectRoot } from "./db-helpers.js"
import { evaluateRootParentPreflight } from "./root-parent-preflight.js"
import { expandTreeIds, fetchEntityDisplayName } from "./search.js"

export interface PreviewInput {
  host: SyncRuntimeHost
  entityType: SyncEntityId
  entityId: string | number
  source: string
  target: string
  /** Allows bypassing the per-table 5M row cap. */
  force?: boolean
  /** Optional FK-only tables explicitly enabled for this preview. */
  enabledOptionalTables?: string[]
  /** Optional identity of the previewing user for governance explainability. */
  userUpn?: string | null
}

export async function previewSync(input: PreviewInput): Promise<SyncPlan> {
  const normalized: PreviewInput = {
    ...input,
    entityId: coerceSyncEntityId(input.entityId)
  }
  // Same gate for HTTP widget and agent tools — published contract only.
  assertPublishedContractCurrent(normalized.host.sync.project.publishReadiness, normalized.entityType)
  const previewId = randomUUID()
  const planId = allocPlanId()
  const t0 = Date.now()
  emit(normalized.host, EventType.SyncPreviewStarted, {
    previewId,
    planId,
    entityType: normalized.entityType,
    entityId: normalized.entityId,
    source: normalized.source,
    target: normalized.target,
    force: Boolean(normalized.force)
  })

  const telemetryContext: SyncTelemetryContext = {
    kind: SyncOperationType.Preview,
    opId: previewId,
    planId,
    previewId,
    source: normalized.source,
    target: normalized.target
  }
  return previewSyncInner(normalized, previewId, planId, t0, telemetryContext)
}

async function previewSyncInner(
  input: PreviewInput,
  previewId: string,
  planId: PlanId,
  t0: number,
  telemetryContext: SyncTelemetryContext
): Promise<SyncPlan> {
  const entityId = input.entityId
  try {
    const createdAt = new Date().toISOString()
    const createdAtMs = Date.now()
    const definition = getPublishedSyncDefinition(input.host, projectRoot(input.host), asEntityId(input.entityType))
    const selection = selectDefinitionTables(definition, input.enabledOptionalTables)
    const activeTables = selection.tables

    // Validate environments
    const sourceEnv = getEnvironment(input.host, input.source)
    const targetEnv = getEnvironment(input.host, input.target)
    if (sourceEnv.role === "target")
      throw new Error(`Environment "${sourceEnv.name}" is target-only — cannot use as source.`)
    if (targetEnv.role === "source")
      throw new Error(`Environment "${targetEnv.name}" is source-only — cannot use as target.`)
    const readyIds = readyMssqlConnectorIds(input.host)
    assertEnvConnectorReady(sourceEnv, readyIds)
    assertEnvConnectorReady(targetEnv, readyIds)
    assertSupportedSyncDirection(sourceEnv, targetEnv)

    const freezeEvaluation = evaluateFreezeWindows(definition.governance.freezeWindowIds)
    const governanceWarnings: string[] = []
    if (freezeEvaluation.active) {
      governanceWarnings.push(
        `Active freeze window(s) at preview time: ${freezeEvaluation.activeWindows.map((window) => `${window.id} (${window.displayName})`).join(", ")}. Execute will be blocked unless overridden.`
      )
    }
    if (freezeEvaluation.unknownIds.length > 0) {
      governanceWarnings.push(
        `Unknown freeze window id(s) referenced by definition: ${freezeEvaluation.unknownIds.join(", ")}.`
      )
    }

    const governanceDecision = {
      evaluatedAt: createdAt,
      governance: {
        freezeWindowIds: [...definition.governance.freezeWindowIds],
      },
      freezeWindows: {
        active: freezeEvaluation.active,
        activeWindows: freezeEvaluation.activeWindows.map((window) => ({
          id: window.id,
          displayName: window.displayName,
          startsAt: window.startsAt,
          endsAt: window.endsAt
        })),
        unknownIds: [...freezeEvaluation.unknownIds]
      },
      targetEnvironment: {
        name: targetEnv.name,
        role: targetEnv.role,
        actorUpn: input.userUpn ?? null,
      },
      warnings: governanceWarnings
    }

    // Resolve entity display name
    const displayName = await fetchEntityDisplayName(input.host, definition, entityId, input.source, telemetryContext)

    const expandedIds = definition.selfJoinColumn
      ? await expandTreeIds(input.host, definition, entityId, input.source, telemetryContext)
      : null

    const allowedSchemas = Array.from(
      new Set(
        activeTables
          .map((t) => {
            const ix = t.name.indexOf(".")
            return ix > 0 ? t.name.slice(0, ix) : ""
          })
          .filter((s) => s.length > 0)
      )
    )
    let catalogPreflight: { catalogCompatible: boolean; issues: string[] }
    try {
      catalogPreflight = await detectCatalogDrift(
        input.host,
        input.source,
        input.target,
        activeTables.map((t) => t.name),
        allowedSchemas,
        telemetryContext
      )
    } catch (e) {
      catalogPreflight = {
        catalogCompatible: false,
        issues: [`Catalog drift check failed: ${e instanceof Error ? e.message : String(e)}`]
      }
    }

    const tableNames = activeTables.map((t) => t.name)
    const [sourceColumnsByTable, targetColumnsByTable] = await Promise.all([
      fetchTableColumnNamesMap(input.host, input.source, tableNames, telemetryContext),
      fetchTableColumnNamesMap(input.host, input.target, tableNames, telemetryContext),
    ])
    const materialized = materializeDefinitionTablesForSchema(
      activeTables,
      sourceColumnsByTable,
      targetColumnsByTable,
    )
    const schemaGroundedTables = materialized.tables

    // Per-table diff with bounded concurrency. Going wider exhausts the mssql
    // pool and produces "Connection is closed" cascades that flap classification
    // between runs (a failed table reports counts:0/0/0/0 instead of its real
    // unchanged count, so totals jitter from one preview to the next).
    const pkColumnsByTable = await fetchPkColumns(
      input.host,
      input.source,
      schemaGroundedTables.map((t) => t.name)
    )
    const tableConcurrency = resolvePreviewTableConcurrency(
      input.host,
      input.source,
      input.target
    )
    const tableTotal = schemaGroundedTables.length
    const tableResults: SyncPlanTable[] = await mapWithConcurrency(
      schemaGroundedTables.map((t, tableIndex) => ({ t, tableIndex })),
      tableConcurrency,
      async ({ t, tableIndex }) => {
        const tableT0 = Date.now()
        const predicate = expandedIds
          ? instantiatePredicateWithTree(t.predicate, entityId, expandedIds)
          : instantiatePredicate(t.predicate, entityId)
        emit(input.host, EventType.SyncPreviewTableStart, {
          previewId,
          planId,
          table: t.name,
          predicate,
          tableIndex: tableIndex + 1,
          tableTotal
        })
        try {
          const r = await diffTable(
            input.host,
            t,
            entityId,
            input.source,
            input.target,
            pkColumnsByTable.get(t.name) ?? [],
            { rowCap: input.force ? Number.MAX_SAFE_INTEGER : undefined, expandedIds, telemetryContext }
          )
          const m = movementFromChangeSet(r.changeSet)
          emit(input.host, EventType.SyncPreviewTableDone, {
            previewId,
            planId,
            table: t.name,
            tableIndex: tableIndex + 1,
            tableTotal,
            insert: m.insert,
            update: m.update,
            delete: m.delete,
            durationMs: r.diffDurationMs
          })
          return r
        } catch (e: unknown) {
          const errMsg = e instanceof Error ? e.message : String(e)
          console.error(`[sync.preview] diffTable(${t.name}) failed after retries:`, e)
          emit(input.host, EventType.SyncPreviewTableFailed, {
            previewId,
            planId,
            table: t.name,
            tableIndex: tableIndex + 1,
            tableTotal,
            error: errMsg
          })
          return {
            table: t.name,
            scopePredicate: predicate,
            stats: { unchanged: 0, lowConfidence: 0 },
            changeSet: emptyChangeSet(),
            samples: { insert: [], update: [], delete: [] },
            conflicts: [],
            warnings: [`Diff failed: ${errMsg}`],
            diffDurationMs: Date.now() - tableT0
          } as SyncPlanTable
        }
      }
    )

    const totals: SyncPlanTotals = computePlanTotals(tableResults)

    const warnings: string[] = [...governanceWarnings.map((warning) => `[governance] ${warning}`)]
    for (const d of definition.metadata.discrepancies) warnings.push(`[${d.kind}] ${d.table}: ${d.note}`)
    for (const issue of catalogPreflight.issues) warnings.push(`[drift] ${issue}`)
    const activeNames = new Set(activeTables.map((table) => table.name))
    const disabledOptionalTables = definition.metadata.tables
      .filter((table) => table.userControllable && !activeNames.has(table.name))
      .map((table) => table.name)
    const enabledOptionalTables = definition.metadata.tables
      .filter((table) => table.userControllable && activeNames.has(table.name))
      .map((table) => table.name)
    if (disabledOptionalTables.length > 0) {
      warnings.unshift(
        `FK-only tables excluded by default: ${disabledOptionalTables.join(", ")}. Enable them explicitly to include closure-only rows in the preview.`
      )
    }

    // Surface diff failures at the plan level so the UI can show "preview is
    // unreliable, retry" prominently instead of users having to expand each
    // failed table to spot the per-row warning.
    const failedTables = tableResults.filter((t) => t.warnings.some((w) => w.startsWith("Diff failed:")))
    if (failedTables.length > 0) {
      warnings.unshift(
        `Preview incomplete: ${failedTables.length}/${tableResults.length} table(s) failed to diff (${failedTables.map((t) => t.table).join(", ")}). ` +
          `Totals shown EXCLUDE these tables and will jitter between runs. Re-run the preview.`
      )
    }

    if (materialized.omissionSummaries.length > 0) {
      warnings.push(
        ...materialized.omissionSummaries.map((line) => `[scd2-schema] ${line}`),
      )
    }

    const decisionLog = [
      {
        id: "scd2-schema-grounding",
        recordedAt: createdAt,
        stage: "preview" as const,
        category: "definition" as const,
        severity: materialized.omissionSummaries.length > 0 ? ("info" as const) : ("info" as const),
        title: "SCD2 policy grounded on live schema",
        summary:
          materialized.omissionSummaries.length > 0
            ? `${materialized.omissionSummaries.length} table(s): strategy columns omitted where absent on source/target.`
            : "All strategy columns present on synced tables for this plan.",
        details: {
          omissions: materialized.omissionSummaries,
        },
      },
      {
        id: "definition-contract",
        recordedAt: createdAt,
        stage: "preview" as const,
        category: "definition" as const,
        severity: "info" as const,
        title: "Published definition selected",
        summary: `Using published definition ${definition.id}@${definition.publishedVersion}.`,
        details: {
          definitionId: definition.id,
          displayName: definition.displayName,
          publishedVersion: definition.publishedVersion,
          publishedAt: definition.publishedAt,
          provenance: definition.provenance,
          bindings: definition.bindings
        }
      },
      {
        id: "compiled-flow",
        recordedAt: createdAt,
        stage: "preview" as const,
        category: "flow" as const,
        severity: "info" as const,
        title: "Execution flow compiled",
        summary: `${definition.executionFlow.steps.length} explicit step(s): ${definition.executionFlow.steps.map((step) => step.kind).join(" -> ")}.`,
        details: {
          stepCount: definition.executionFlow.steps.length,
          steps: definition.executionFlow.steps.map((step) => ({
            id: step.id,
            phase: step.phase,
            kind: step.kind,
            title: step.title,
            description: step.description
          }))
        }
      },
      {
        id: "optional-table-selection",
        recordedAt: createdAt,
        stage: "preview" as const,
        category: "scope" as const,
        severity: disabledOptionalTables.length > 0 ? ("warning" as const) : ("info" as const),
        title: "Table scope selected",
        summary:
          disabledOptionalTables.length > 0
            ? `${activeTables.length} table(s) included; optional FK-only tables excluded: ${disabledOptionalTables.join(", ")}.`
            : `${activeTables.length} table(s) included with no optional-table exclusions.`,
        details: {
          selectedTables: activeTables.map((table) => table.name),
          enabledOptionalTables,
          disabledOptionalTables
        }
      },
      {
        id: "catalog-preflight",
        recordedAt: createdAt,
        stage: "preview" as const,
        category: "preflight" as const,
        severity: catalogPreflight.catalogCompatible ? ("info" as const) : ("warning" as const),
        title: "Catalog preflight evaluated",
        summary: catalogPreflight.catalogCompatible
          ? `Catalog compatible across ${allowedSchemas.length} allowed schema(s).`
          : `Catalog drift surfaced ${catalogPreflight.issues.length} issue(s) before execute.`,
        details: {
          catalogCompatible: catalogPreflight.catalogCompatible,
          allowedSchemas,
          issues: catalogPreflight.issues
        }
      },
      {
        id: "governance-evaluation",
        recordedAt: createdAt,
        stage: "preview" as const,
        category: "governance" as const,
        severity: governanceWarnings.length > 0 ? ("warning" as const) : ("info" as const),
        title: "Governance evaluated",
        summary:
          governanceWarnings.length > 0
            ? governanceWarnings.join(" ")
            : `No governance blockers detected at preview time for ${targetEnv.name}.`,
        details: governanceDecision
      }
    ]

    const flowCatalogSnapshot = requirePublishedFlowCatalog(definition)

    const plan: SyncPlan = {
      planId,
      createdAt,
      createdAtMs,
      entity: { type: input.entityType, id: entityId, displayName },
      source: input.source,
      target: input.target,
      preflight: {
        ...catalogPreflight,
        rootParentReady: true,
        rootParentIssue: null,
      },
      tables: tableResults,
      totals,
      dependencyGraph: buildDependencyGraph(definition.rootTable, activeTables, tableResults),
      warnings,
      estimatedDurationSec: Math.max(2, Math.ceil((totals.insert + totals.update + totals.delete) / 500)),
      executionContract: {
        definitionId: definition.id,
        definitionPublishedVersion: definition.publishedVersion,
        definitionPublishedAt: definition.publishedAt,
        governance: {
          freezeWindowIds: [...definition.governance.freezeWindowIds],
        },
        bindings: {
          serviceProfileRef: definition.bindings.serviceProfileRef,
          environmentPolicyRef: definition.bindings.environmentPolicyRef
        },
        allowedSchemas,
        metadata: {
          rootTable: definition.rootTable,
          rootKeyColumn: definition.idColumn,
          selfJoinColumn: definition.selfJoinColumn,
          tables: schemaGroundedTables.map((t) => ({
            name: t.name,
            scopeColumn: t.scopeColumn,
            predicate: t.predicate,
            ...(t.scd2Policy ? { scd2Policy: t.scd2Policy } : {}),
          })),
          executionOrder: selection.executionOrder,
          reverseOrder: selection.reverseOrder,
          enabledOptionalTables
        },
        flow: {
          steps: definition.executionFlow.steps.map((step) => ({
            id: step.id,
            phase: step.phase,
            kind: step.kind,
            title: step.title,
            description: step.description,
            bindings: step.bindings ?? {},
            objectName: step.objectName ?? null,
            auditObjectType: step.auditObjectType ?? null,
            pipelineName: step.pipelineName ?? null
          })),
          catalog: flowCatalogSnapshot
        },
        provenance: {
          kind: definition.provenance.kind,
          sourceArtifact: definition.provenance.sourceArtifact ?? null,
          sourceVersion: definition.provenance.sourceVersion ?? null
        }
      },
      decisionLog,
      governanceDecision,
      entityPolicies: {
        freezeWindowIds: [...definition.governance.freezeWindowIds],
        sourceEntityVersion: null
      }
    }

    try {
      const rootParent = await evaluateRootParentPreflight(input.host, input.target, plan)
      plan.preflight = {
        ...plan.preflight,
        rootParentReady: rootParent.ready,
        rootParentIssue: rootParent.issue
      }
      if (!rootParent.ready && rootParent.issue) {
        plan.warnings.push(`[preflight] ${rootParent.issue}`)
      }
      plan.decisionLog = [
        ...(plan.decisionLog ?? []),
        {
          id: "root-parent-preflight",
          recordedAt: createdAt,
          stage: "preview" as const,
          category: "preflight" as const,
          severity: rootParent.ready ? ("info" as const) : ("error" as const),
          title: "Root parent on target",
          summary: rootParent.ready
            ? `Root row ready on target or planned as insert (${rootParent.details.rootTable}).`
            : rootParent.issue ?? "Root parent missing on target.",
          details: rootParent.details
        }
      ]
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      plan.preflight = {
        ...plan.preflight,
        rootParentReady: false,
        rootParentIssue: `Root parent preflight failed: ${errMsg}`
      }
      plan.warnings.push(`[preflight] Root parent check failed: ${errMsg}`)
    }

    savePlan(input.host, plan)

    emit(input.host, EventType.SyncPreviewCompleted, {
      previewId,
      planId: plan.planId,
      definitionId: definition.id,
      definitionPublishedVersion: definition.publishedVersion,
      decisionLogCount: decisionLog.length,
      entityType: input.entityType,
      entityId: input.entityId,
      entityDisplayName: displayName,
      source: input.source,
      target: input.target,
      totals,
      failedTables: failedTables.map((t) => t.table),
      durationMs: Date.now() - t0
    })

    return plan
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    emit(input.host, EventType.SyncPreviewFailed, {
      previewId,
      planId,
      entityType: input.entityType,
      entityId: input.entityId,
      source: input.source,
      target: input.target,
      error: errMsg,
      durationMs: Date.now() - t0
    })
    throw e
  }
}
