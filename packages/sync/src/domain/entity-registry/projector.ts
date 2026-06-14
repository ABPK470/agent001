/**
 * Recipe projector — pure transform from a versioned `EntityDefinition`
 * + a resolved `Scd2Strategy` into the legacy `SyncRecipe` compatibility
 * shape.
 *
 * Why a projector?
 *   This is now a compatibility seam for registry-driven flows and
 *   migration tooling. The primary runtime path uses published sync
 *   definitions compiled in-repo; this projector remains useful where a
 *   registry definition still needs to be compared or transformed into
 *   the older recipe-shaped contract.
 *
 * Pure, IO-free, deterministic — `projectRecipe(def, strategy)` always
 * produces byte-identical output for the same inputs (modulo
 * `generatedAt`, which the caller supplies).
 *
 * Scope handling per table:
 *   - `rootPk`  → `scopeColumn = column`, predicate = `{column} = {id}` (or
 *                 `{column} IN ({ids})` when the root has a self-join
 *                 column for tree expansion).
 *   - `fkPath`  → scopeColumn null, predicate = EXISTS sub-query chained
 *                 through the FK hops.
 *   - `sql`     → scopeColumn null, predicate = the raw template verbatim
 *                 (validation has already vetted it for unsafe fragments).
 *
 * SCD2 effective columns are snapshotted alongside each table via
 * {@link ProjectedSyncRecipe.effectiveScd2}, parallel to `tables[]`.
 */

import { DiscoverySource, SyncRecipeDiscrepancyKind } from "../enums.js"
import type { SyncRecipe, SyncRecipeTable } from "../recipes.js"
import { orderEntityTables } from "./order.js"
import { projectTablePredicate } from "./project-predicate.js"
import { resolveEffectiveScd2 } from "./strategy-resolver.js"
import type { EffectiveScd2, EntityDefinition, EntityTable, Scd2Strategy } from "./types.js"

/**
 * A `SyncRecipe` extended with the per-table effective SCD2 snapshot.
 * Backwards-compatible with consumers of `SyncRecipe` (extra field is
 * opt-in to read).
 */
export interface ProjectedSyncRecipe extends SyncRecipe {
  /** Index-aligned with `tables[]`. */
  effectiveScd2: EffectiveScd2[]
  /** Provenance of the projection. */
  projectedFrom: {
    tenantId: string
    entityId: string
    entityVersion: number
    strategyId: string
    strategyVersion: number
  }
}

/**
 * Project a definition + resolved strategy into a runtime recipe.
 *
 * `generatedAt` defaults to ISO-now; pass an explicit value when you want
 * the projection to be a pure function of its inputs (e.g. tests).
 */
export function projectRecipe(args: {
  def: EntityDefinition
  strategy: Scd2Strategy
  generatedAt?: string
}): ProjectedSyncRecipe {
  const { def, strategy } = args
  const generatedAt = args.generatedAt ?? new Date().toISOString()
  const hasSelfJoin = def.selfJoinColumn !== null && def.selfJoinColumn.trim() !== ""

  const sortedTables = orderEntityTables(def)

  const tables: SyncRecipeTable[] = []
  const effectiveScd2: EffectiveScd2[] = []
  const archiveTables: Array<string | null> = []

  for (const t of sortedTables) {
    tables.push(projectTable(t, def))
    effectiveScd2.push(resolveEffectiveScd2({ strategy, entityOverride: def.scd2.entityOverride, table: t }))
    archiveTables.push(t.archiveTable ?? deriveArchiveTable(t.name))
  }

  const orderedNames = tables.map((t) => t.name)

  return {
    entityType: def.id,
    displayName: def.displayName,
    rootTable: def.rootTable,
    rootKeyColumn: def.idColumn,
    rootNameColumn: def.labelColumn,
    legacyPipelineId: def.provenance.kind === "legacy-migration" ? def.provenance.legacyPipelineId : null,
    selfJoinColumn: hasSelfJoin ? def.selfJoinColumn : null,
    tables,
    executionOrder: orderedNames,
    reverseOrder: [...orderedNames].reverse(),
    postMetadataActions: [],
    archiveTables,
    discrepancies: collectDiscrepancies(sortedTables),
    generatedAt,
    effectiveScd2,
    projectedFrom: {
      tenantId: def.tenantId,
      entityId: def.id,
      entityVersion: def.version,
      strategyId: strategy.id,
      strategyVersion: strategy.version
    }
  }
}

// ── Per-table projection ────────────────────────────────────────────

function projectTable(t: EntityTable, def: EntityDefinition): SyncRecipeTable {
  const scopeColumn = t.scope.kind === "rootPk" ? t.scope.column : null
  const predicate = projectTablePredicate(def, t)
  // All registry-sourced rows are presumed grounded at projection time; the
  // `verified` flag tracks human review independently.
  const source = DiscoverySource.FkAndPipeline
  return {
    name: t.name,
    scopeColumn,
    predicate,
    source,
    verified: t.verified,
    groundedByPipeline: true,
    enabledByDefault: true,
    userControllable: false,
    note: t.note ?? undefined
  }
}

function deriveArchiveTable(qualified: string): string | null {
  // Convention: `core.Contract` → `coreArchive.Contract`.
  const dot = qualified.indexOf(".")
  if (dot < 0) return null
  const schema = qualified.slice(0, dot)
  const name = qualified.slice(dot + 1)
  if (schema.endsWith("Archive")) return null
  return `${schema}Archive.${name}`
}

function collectDiscrepancies(tables: readonly EntityTable[]): SyncRecipe["discrepancies"] {
  // Unverified rows are reported as "implicit" — the row exists in the
  // registry but has not been confirmed against ground truth. This
  // mirrors what the introspector does for FK-derived rows.
  const out: SyncRecipe["discrepancies"] = []
  for (const t of tables) {
    if (!t.verified) {
      out.push({
        table: t.name,
        kind: SyncRecipeDiscrepancyKind.Implicit,
        note: t.note ?? "unverified entity-registry row; review against ground truth"
      })
    }
  }
  return out
}
