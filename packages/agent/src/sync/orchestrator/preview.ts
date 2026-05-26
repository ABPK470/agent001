/**
 * `previewSync` — builds a SyncPlan for a given entity by running the
 * diff engine across every recipe table in parallel, validating
 * environments + catalog drift, and persisting the plan.
 *
 * @module
 */

import { randomUUID } from "node:crypto"
import { EventType } from "../../domain/enums/event.js"
import { SyncOperationType } from "../../domain/enums/sync.js"
import type { AgentHost } from "../../host/index.js"
import { detectCatalogDrift } from "../catalog-drift.js"
import { buildDependencyGraph, diffTable } from "../diff-engine/index.js"
import { tryResolveRecipe } from "../entity-registry/resolver.js"
import { getEnvironment } from "../environments.js"
import {
    allocPlanId,
    savePlan,
    type SyncPlan,
    type SyncPlanTable,
    type SyncPlanTotals,
} from "../plan-store.js"
import {
    getRecipe,
    instantiatePredicate,
    instantiatePredicateWithTree,
    loadSyncRecipes,
    selectRecipeTables,
    type EntityType,
    type SyncRecipe,
    type SyncRecipeTable,
} from "../recipes.js"
import { emitSyncEvent as emit, type SyncSqlTraceContext } from "../sync-events.js"
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
}

export async function previewSync(input: PreviewInput): Promise<SyncPlan> {
  const previewId = randomUUID()
  const t0 = Date.now()
  const syncTrace: SyncSqlTraceContext = { kind: SyncOperationType.Preview, opId: previewId, source: input.source, target: input.target }
  emit(input.host, EventType.SyncPreviewStarted, {
    previewId,
    entityType: input.entityType,
    entityId: input.entityId,
    source: input.source,
    target: input.target,
    force: Boolean(input.force),
  })

  return previewSyncInner(input, previewId, t0, syncTrace)
}

async function previewSyncInner(input: PreviewInput, previewId: string, t0: number, syncTrace: SyncSqlTraceContext): Promise<SyncPlan> {
  try {
    // Lookup order: entity-registry resolver wins; on miss, fall back to
    // the bundled JSON. Both produce the same `SyncRecipe` shape so the
    // downstream code path is identical.
    const resolved = tryResolveRecipe(input.host, { tenantId: "_default", entityId: input.entityType })
    const fullRecipe = resolved?.recipe ?? (() => {
      const bundle = loadSyncRecipes(input.host, projectRoot(input.host))
      return getRecipe(bundle, input.entityType)
    })()
    const resolvedPolicies = resolved?.policies ?? null
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
    // Hard block: PROD is read-only until explicitly unlocked by ops (SYNC_ALLOW_PROD=1).
    if (targetEnv.name.toLowerCase() === "prod" && !process.env["SYNC_ALLOW_PROD"]) {
      throw new Error(`Sync to PROD is currently disabled. Set SYNC_ALLOW_PROD=1 to unlock.`)
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
    const pkColumnsByTable = await fetchPkColumns(input.host, input.source, recipe.tables.map((t) => t.name), syncTrace)
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
            { rowCap: input.force ? Number.MAX_SAFE_INTEGER : undefined, expandedIds, syncTrace },
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

    const warnings: string[] = []
    for (const d of recipe.discrepancies) warnings.push(`[${d.kind}] ${d.table}: ${d.note}`)
    for (const issue of preflight.issues) warnings.push(`[drift] ${issue}`)
    const disabledOptionalTables = fullRecipe.tables
      .filter((table) => table.userControllable && !selectedTableNames.has(table.name))
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

    const plan: SyncPlan = {
      planId: allocPlanId(),
      createdAt: new Date().toISOString(),
      createdAtMs: Date.now(),
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
        enabledOptionalTables: recipe.tables.filter((table) => table.userControllable).map((table) => table.name),
      },
      entityPolicies: resolvedPolicies,
    }
    savePlan(input.host, plan)

    emit(input.host, EventType.SyncPreviewCompleted, {
      previewId,
      planId: plan.planId,
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
