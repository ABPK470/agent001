/**
 * `previewSync` — builds a SyncPlan for a given entity by running the
 * diff engine across every recipe table in parallel, validating
 * environments + catalog drift, and persisting the plan.
 *
 * @module
 */

import { randomUUID } from "node:crypto"
import { detectCatalogDrift } from "../../../domain/catalog-drift.js"
import { buildDependencyGraph, diffTable } from "../../../domain/diff-engine/index.js"
import { assertSupportedSyncDirection, getEnvironment } from "../../../domain/environments.js"
import { evaluateFreezeWindows } from "../../../domain/governance/freeze-windows.js"
import { definitionToSyncRecipe, getPublishedSyncDefinition } from "../../../domain/published-definitions.js"
import {
    instantiatePredicate,
    instantiatePredicateWithTree,
    selectRecipeTables,
    type EntityType,
    type SyncRecipe,
    type SyncRecipeTable,
} from "../../../domain/recipes.js"
import { EventType, SyncOperationType, type AgentHost } from "../../../ports/index.js"
import { emitSyncEvent as emit, type SyncTelemetryContext } from "../events.js"
import {
    allocPlanId,
    savePlan,
    type SyncPlan,
    type SyncPlanTable,
    type SyncPlanTotals,
} from "../plan-store.js"
import { fetchPkColumns } from "./apply.js"
import { mapWithConcurrency, PREVIEW_TABLE_CONCURRENCY, projectRoot } from "./db-helpers.js"
import { expandTreeIds, fetchEntityDisplayName } from "./search.js"

export interface PreviewInput {
  host: AgentHost
  entityType: EntityType
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
  const previewId = randomUUID()
  const t0 = Date.now()
  emit(input.host, EventType.SyncPreviewStarted, {
    previewId,
    entityType: input.entityType,
    entityId: input.entityId,
    source: input.source,
    target: input.target,
    force: Boolean(input.force),
  })

  const telemetryContext: SyncTelemetryContext = {
    kind: SyncOperationType.Preview,
    opId: previewId,
    source: input.source,
    target: input.target,
  }
  return previewSyncInner(input, previewId, t0, telemetryContext)
}

async function previewSyncInner(input: PreviewInput, previewId: string, t0: number, telemetryContext: SyncTelemetryContext): Promise<SyncPlan> {
  try {
    const createdAt = new Date().toISOString()
    const createdAtMs = Date.now()
    const definition = getPublishedSyncDefinition(input.host, projectRoot(input.host), input.entityType)
    const fullRecipe = definitionToSyncRecipe(definition)
    const selection = selectRecipeTables(fullRecipe, input.enabledOptionalTables)
    const selectedTableNames = new Set(selection.tables.map((table) => table.name))
    const recipe: SyncRecipe = {
      ...fullRecipe,
      tables: selection.tables,
      executionOrder: selection.executionOrder,
      reverseOrder: selection.reverseOrder,
      archiveTables: fullRecipe.archiveTables.filter((_, index) => selectedTableNames.has(fullRecipe.tables[index]?.name ?? "")),
    }

    // Validate environments
    const sourceEnv = getEnvironment(input.host, input.source)
    const targetEnv = getEnvironment(input.host, input.target)
    if (sourceEnv.role === "target") throw new Error(`Environment "${sourceEnv.name}" is target-only — cannot use as source.`)
    if (targetEnv.role === "source") throw new Error(`Environment "${targetEnv.name}" is source-only — cannot use as target.`)
    assertSupportedSyncDirection(sourceEnv, targetEnv)
    // Hard block: PROD is read-only until explicitly unlocked by ops (SYNC_ALLOW_PROD=1).
    if (targetEnv.name.toLowerCase() === "prod" && !process.env["SYNC_ALLOW_PROD"]) {
      throw new Error(`Sync to PROD is currently disabled. Set SYNC_ALLOW_PROD=1 to unlock.`)
    }

    const freezeEvaluation = evaluateFreezeWindows(definition.governance.freezeWindowIds)
    const actorAllowed = input.userUpn
      ? (targetEnv.syncAllowlist.length === 0 || targetEnv.syncAllowlist.includes(input.userUpn))
      : null
    const governanceWarnings: string[] = []
    if (freezeEvaluation.active) {
      governanceWarnings.push(
        `Active freeze window(s) at preview time: ${freezeEvaluation.activeWindows.map((window) => `${window.id} (${window.displayName})`).join(", ")}. Execute will be blocked unless overridden.`,
      )
    }
    if (freezeEvaluation.unknownIds.length > 0) {
      governanceWarnings.push(`Unknown freeze window id(s) referenced by definition: ${freezeEvaluation.unknownIds.join(", ")}.`)
    }
    if (actorAllowed === false && input.userUpn) {
      governanceWarnings.push(`User ${input.userUpn} is not in the target sync allowlist for ${targetEnv.name}; execute will be blocked.`)
    }

    const governanceDecision = {
      evaluatedAt: createdAt,
      governance: {
        approvalPolicyId: definition.governance.approvalPolicyId,
        freezeWindowIds: [...definition.governance.freezeWindowIds],
        riskMultiplier: definition.governance.riskMultiplier,
      },
      freezeWindows: {
        active: freezeEvaluation.active,
        activeWindows: freezeEvaluation.activeWindows.map((window) => ({
          id: window.id,
          displayName: window.displayName,
          startsAt: window.startsAt,
          endsAt: window.endsAt,
        })),
        unknownIds: [...freezeEvaluation.unknownIds],
      },
      targetEnvironment: {
        name: targetEnv.name,
        role: targetEnv.role,
        prodSyncUnlocked: targetEnv.name.toLowerCase() !== "prod" || Boolean(process.env["SYNC_ALLOW_PROD"]),
        syncAllowlistEnabled: targetEnv.syncAllowlist.length > 0,
        actorUpn: input.userUpn ?? null,
        actorAllowed,
      },
      warnings: governanceWarnings,
    }

    // Resolve entity display name
    const displayName = await fetchEntityDisplayName(input.host, recipe, input.entityId, input.source)

    // Tree expansion: when the recipe root table has a self-referencing FK
    // (e.g. core.Rule.parentRuleId → core.Rule.ruleId), expand the single
    // entity ID to the full descendant tree. Predicates using {ids} will
    // receive the complete set; {id} still binds to the root entity only.
    const expandedIds = recipe.selfJoinColumn
      ? await expandTreeIds(input.host, recipe, input.entityId, input.source)
      : null

    //// Allowed schemas come from the recipe itself — every table is
    // schema-qualified, so we union the prefixes and feed them to the
    // drift check. This removes the historical hardcoded Mymi-only
    // allowlist and lets registry-defined entities span any schemas.
    const allowedSchemas = Array.from(new Set(recipe.tables.map((t) => {
      const ix = t.name.indexOf(".")
      return ix > 0 ? t.name.slice(0, ix) : ""
    }).filter((s) => s.length > 0)))
    let preflight: { catalogCompatible: boolean; issues: string[] }
    try {
      preflight = await detectCatalogDrift(
        input.host,
        input.source,
        input.target,
        recipe.tables.map((t) => t.name),
        allowedSchemas,
      )
    } catch (e) {
      preflight = {
        catalogCompatible: false,
        issues: [`Catalog drift check failed: ${e instanceof Error ? e.message : String(e)}`],
      }
    }

    // Per-table diff with bounded concurrency. Going wider exhausts the mssql
    // pool and produces "Connection is closed" cascades that flap classification
    // between runs (a failed table reports counts:0/0/0/0 instead of its real
    // unchanged count, so totals jitter from one preview to the next).
    const pkColumnsByTable = await fetchPkColumns(input.host, input.source, recipe.tables.map((t) => t.name))
    const tableResults: SyncPlanTable[] = await mapWithConcurrency(
      recipe.tables,
      PREVIEW_TABLE_CONCURRENCY,
      async (t: SyncRecipeTable) => {
        const tableT0 = Date.now()
        const predicate = expandedIds
          ? instantiatePredicateWithTree(t.predicate, input.entityId, expandedIds)
          : instantiatePredicate(t.predicate, input.entityId)
        emit(input.host, EventType.SyncPreviewTableStart, { previewId, table: t.name, predicate })
        try {
          const r = await diffTable(
            input.host,
            recipe,
            t,
            input.entityId,
            input.source,
            input.target,
            pkColumnsByTable.get(t.name) ?? [],
            { rowCap: input.force ? Number.MAX_SAFE_INTEGER : undefined, expandedIds, telemetryContext },
          )
          emit(input.host, EventType.SyncPreviewTableDone, {
            previewId, table: t.name, counts: r.counts, durationMs: r.diffDurationMs,
          })
          return r
        } catch (e: unknown) {
          // Log the full error (with stack) to server logs — the .catch
          // would otherwise swallow it into a single-line warning string.
          const errMsg = e instanceof Error ? e.message : String(e)
          console.error(`[sync.preview] diffTable(${t.name}) failed after retries:`, e)
          emit(input.host, EventType.SyncPreviewTableFailed, { previewId, table: t.name, error: errMsg })
          return {
            table: t.name,
            scopePredicate: predicate,
            counts: { insert: 0, update: 0, delete: 0, unchanged: 0, lowConfidence: 0, conflicts: 0 },
            samples: { insert: [], update: [], delete: [] },
            conflicts: [],
            warnings: [`Diff failed: ${errMsg}`],
            diffDurationMs: Date.now() - tableT0,
          } as SyncPlanTable
        }
      },
    )

    const totals: SyncPlanTotals = tableResults.reduce(
      (acc: SyncPlanTotals, t: SyncPlanTable) => ({
        insert: acc.insert + t.counts.insert,
        update: acc.update + t.counts.update,
        delete: acc.delete + t.counts.delete,
        unchanged: acc.unchanged + t.counts.unchanged,
        lowConfidence: acc.lowConfidence + t.counts.lowConfidence,
        conflicts: acc.conflicts + t.counts.conflicts,
        tablesCount: acc.tablesCount + (t.counts.insert + t.counts.update + t.counts.delete + t.counts.conflicts > 0 ? 1 : 0),
      }),
      { insert: 0, update: 0, delete: 0, unchanged: 0, lowConfidence: 0, conflicts: 0, tablesCount: 0 },
    )

    const warnings: string[] = [...governanceWarnings.map((warning) => `[governance] ${warning}`)]
    for (const d of recipe.discrepancies) warnings.push(`[${d.kind}] ${d.table}: ${d.note}`)
    for (const issue of preflight.issues) warnings.push(`[drift] ${issue}`)
    const disabledOptionalTables = fullRecipe.tables
      .filter((table) => table.userControllable && !selectedTableNames.has(table.name))
      .map((table) => table.name)
    const enabledOptionalTables = fullRecipe.tables
      .filter((table) => table.userControllable && selectedTableNames.has(table.name))
      .map((table) => table.name)
    if (disabledOptionalTables.length > 0) {
      warnings.unshift(
        `FK-only tables excluded by default: ${disabledOptionalTables.join(", ")}. Enable them explicitly to include closure-only rows in the preview.`,
      )
    }

    // Surface diff failures at the plan level so the UI can show "preview is
    // unreliable, retry" prominently instead of users having to expand each
    // failed table to spot the per-row warning.
    const failedTables = tableResults.filter((t) => t.warnings.some((w) => w.startsWith("Diff failed:")))
    if (failedTables.length > 0) {
      warnings.unshift(
        `Preview incomplete: ${failedTables.length}/${tableResults.length} table(s) failed to diff (${failedTables.map((t) => t.table).join(", ")}). ` +
        `Totals shown EXCLUDE these tables and will jitter between runs. Re-run the preview.`,
      )
    }

    const decisionLog = [
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
          bindings: definition.bindings,
        },
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
            description: step.description,
          })),
        },
      },
      {
        id: "optional-table-selection",
        recordedAt: createdAt,
        stage: "preview" as const,
        category: "scope" as const,
        severity: disabledOptionalTables.length > 0 ? "warning" as const : "info" as const,
        title: "Table scope selected",
        summary: disabledOptionalTables.length > 0
          ? `${recipe.tables.length} table(s) included; optional FK-only tables excluded: ${disabledOptionalTables.join(", ")}.`
          : `${recipe.tables.length} table(s) included with no optional-table exclusions.`,
        details: {
          selectedTables: recipe.tables.map((table) => table.name),
          enabledOptionalTables,
          disabledOptionalTables,
        },
      },
      {
        id: "catalog-preflight",
        recordedAt: createdAt,
        stage: "preview" as const,
        category: "preflight" as const,
        severity: preflight.catalogCompatible ? "info" as const : "warning" as const,
        title: "Catalog preflight evaluated",
        summary: preflight.catalogCompatible
          ? `Catalog compatible across ${allowedSchemas.length} allowed schema(s).`
          : `Catalog drift surfaced ${preflight.issues.length} issue(s) before execute.`,
        details: {
          catalogCompatible: preflight.catalogCompatible,
          allowedSchemas,
          issues: preflight.issues,
        },
      },
      {
        id: "governance-evaluation",
        recordedAt: createdAt,
        stage: "preview" as const,
        category: "governance" as const,
        severity: governanceWarnings.length > 0 ? "warning" as const : "info" as const,
        title: "Governance evaluated",
        summary: governanceWarnings.length > 0
          ? governanceWarnings.join(" ")
          : `No governance blockers detected at preview time for ${targetEnv.name}.`,
        details: governanceDecision,
      },
    ]

    const plan: SyncPlan = {
      planId: allocPlanId(),
      createdAt,
      createdAtMs,
      entity: { type: input.entityType, id: input.entityId, displayName },
      source: input.source,
      target: input.target,
      preflight, // computed above from detectCatalogDrift restricted to recipe.tables
      tables: tableResults,
      totals,
      dependencyGraph: buildDependencyGraph(recipe, tableResults),
      warnings,
      estimatedDurationSec: Math.max(2, Math.ceil((totals.insert + totals.update + totals.delete) / 500)),
      recipeSnapshot: {
        entityType: recipe.entityType,
        rootTable: recipe.rootTable,
        rootKeyColumn: recipe.rootKeyColumn,
        legacyPipelineId: recipe.legacyPipelineId ?? undefined,
        tables: recipe.tables.map((t: SyncRecipeTable) => ({ name: t.name, scopeColumn: t.scopeColumn, predicate: t.predicate })),
        executionOrder: recipe.executionOrder,
        reverseOrder: recipe.reverseOrder,
        postMetadataActions: recipe.postMetadataActions.map((action) => ({ kind: action.kind })),
        enabledOptionalTables: recipe.tables.filter((table) => table.userControllable).map((table) => table.name),
      },
      executionContract: {
        definitionId: definition.id,
        definitionPublishedVersion: definition.publishedVersion,
        definitionPublishedAt: definition.publishedAt,
        governance: {
          approvalPolicyId: definition.governance.approvalPolicyId,
          freezeWindowIds: [...definition.governance.freezeWindowIds],
          riskMultiplier: definition.governance.riskMultiplier,
        },
        bindings: {
          serviceProfileRef: definition.bindings.serviceProfileRef,
          environmentPolicyRef: definition.bindings.environmentPolicyRef,
        },
        allowedSchemas,
        metadata: {
          rootTable: recipe.rootTable,
          rootKeyColumn: recipe.rootKeyColumn,
          tables: recipe.tables.map((t: SyncRecipeTable) => ({ name: t.name, scopeColumn: t.scopeColumn, predicate: t.predicate })),
          executionOrder: recipe.executionOrder,
          reverseOrder: recipe.reverseOrder,
        },
        flow: {
          steps: definition.executionFlow.steps.map((step) => ({
            id: step.id,
            phase: step.phase,
            kind: step.kind,
            title: step.title,
            description: step.description,
            bindingRef: step.bindingRef ?? null,
            policyRef: step.policyRef ?? null,
          })),
        },
        provenance: {
          kind: definition.provenance.kind,
          sourceArtifact: definition.provenance.sourceArtifact ?? null,
          sourceVersion: definition.provenance.sourceVersion ?? null,
        },
      },
      decisionLog,
      governanceDecision,
      entityPolicies: {
        approvalPolicyId: definition.governance.approvalPolicyId,
        freezeWindowIds: [...definition.governance.freezeWindowIds],
        riskMultiplier: definition.governance.riskMultiplier,
        sourceEntityVersion: null,
      },
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
      source: input.source,
      target: input.target,
      totals,
      failedTables: failedTables.map((t) => t.table),
      durationMs: Date.now() - t0,
    })

    return plan
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    emit(input.host, EventType.SyncPreviewFailed, {
      previewId,
      entityType: input.entityType,
      entityId: input.entityId,
      source: input.source,
      target: input.target,
      error: errMsg,
      durationMs: Date.now() - t0,
    })
    throw e
  }
}
