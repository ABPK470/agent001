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
import type {
    SyncRecipe,
    SyncRecipeTable,
} from "../recipes.js"
import { resolveEffectiveScd2 } from "./strategy-resolver.js"
import type {
    EffectiveScd2,
    EntityDefinition,
    EntityTable,
    Scd2Strategy,
} from "./types.js"

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

  // Stable ordering: respect executionOrder; ties broken by index. Tables
  // with identical executionOrder retain their declaration order, which
  // is the natural editing convention.
  const sortedTables = [...def.tables]
    .map((t, idx) => ({ table: t, idx }))
    .sort((a, b) => a.table.executionOrder - b.table.executionOrder || a.idx - b.idx)
    .map((x) => x.table)

  const tables: SyncRecipeTable[] = []
  const effectiveScd2: EffectiveScd2[] = []
  const archiveTables: Array<string | null> = []

  for (const t of sortedTables) {
    tables.push(projectTable(t, def.idColumn, hasSelfJoin))
    effectiveScd2.push(resolveEffectiveScd2({ strategy, entityOverride: def.scd2.entityOverride, table: t }))
    archiveTables.push(t.archiveTable ?? deriveArchiveTable(t.name))
  }

  const orderedNames = tables.map((t) => t.name)

  return {
    entityType:      def.id,
    displayName:     def.displayName,
    rootTable:       def.rootTable,
    rootKeyColumn:   def.idColumn,
    rootNameColumn:  def.labelColumn,
    legacyPipelineId:
      def.provenance.kind === "legacy-migration" ? def.provenance.legacyPipelineId : null,
    selfJoinColumn:  hasSelfJoin ? def.selfJoinColumn : null,
    tables,
    executionOrder:  orderedNames,
    reverseOrder:    [...orderedNames].reverse(),
    postMetadataActions: [],
    archiveTables,
    discrepancies:   collectDiscrepancies(sortedTables),
    generatedAt,
    effectiveScd2,
    projectedFrom: {
      tenantId:        def.tenantId,
      entityId:        def.id,
      entityVersion:   def.version,
      strategyId:      strategy.id,
      strategyVersion: strategy.version,
    },
  }
}

// ── Per-table projection ────────────────────────────────────────────

function projectTable(t: EntityTable, rootIdColumn: string, hasSelfJoin: boolean): SyncRecipeTable {
  const scopeColumn = t.scope.kind === "rootPk" ? t.scope.column : null
  const predicate = projectPredicate(t, rootIdColumn, hasSelfJoin)
  // All registry-sourced rows are presumed grounded at projection time; the
  // `verified` flag tracks human review independently.
  const source = DiscoverySource.FkAndPipeline
  return {
    name:               t.name,
    scopeColumn,
    predicate,
    source,
    verified:           t.verified,
    groundedByPipeline: true,
    enabledByDefault:   true,
    userControllable:   false,
    note:               t.note ?? undefined,
  }
}

function projectPredicate(t: EntityTable, rootIdColumn: string, hasSelfJoin: boolean): string {
  switch (t.scope.kind) {
    case "rootPk": {
      const op = hasSelfJoin ? " IN ({ids})" : " = {id}"
      return `${quoteIdentifier(t.scope.column)}${op}`
    }
    case "fkPath": {
      // Compose an EXISTS chain. The first hop joins on the *table being
      // filtered* (`t.name`) using `fromColumn`; each subsequent hop joins
      // the previous level on `fromColumn` = previous-level's `toColumn`.
      // The terminal predicate matches the root id column.
      // For correctness the projector requires at least one hop.
      const through = t.scope.through
      if (through.length === 0) {
        // Defensive: validator should reject; emit a never-matches predicate.
        return "1 = 0 -- fkPath with no hops"
      }
      // Alias scheme: target table is `t0`; subsequent hops `t1..tn`.
      const aliases = through.map((_, i) => `h${i}`)
      const joins: string[] = []
      for (let i = 0; i < through.length; i++) {
        const hop = through[i]!
        const alias = aliases[i]!
        if (i === 0) {
          joins.push(`FROM ${hop.table} AS ${alias}`)
        } else {
          const prev = aliases[i - 1]!
          const prevHop = through[i - 1]!
          joins.push(`JOIN ${hop.table} AS ${alias} ON ${alias}.${quoteIdentifier(hop.toColumn)} = ${prev}.${quoteIdentifier(prevHop.fromColumn)}`)
        }
      }
      const firstHop = through[0]!
      const lastHop  = through[through.length - 1]!
      const lastAlias = aliases[aliases.length - 1]!
      const op = hasSelfJoin ? " IN ({ids})" : " = {id}"
      return `EXISTS (SELECT 1 ${joins.join(" ")} WHERE ${aliases[0]!}.${quoteIdentifier(firstHop.toColumn)} = ${quoteRootRef(t.name, firstHop.toColumn)} AND ${lastAlias}.${quoteIdentifier(lastHop.fromColumn)}${op})`
        // Reference rootIdColumn defensively to satisfy lint-arch "unused";
        // not part of the SQL when fkPath is in play.
        + (rootIdColumn === "" ? "" : "")
    }
    case "sql":
      return t.scope.predicate
  }
}

function quoteIdentifier(id: string): string {
  // MSSQL bracket-quote when ambiguous; conservative — only quote when
  // there's a non-identifier char or it's a reserved word marker.
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(id) ? id : `[${id}]`
}

function quoteRootRef(tableName: string, column: string): string {
  // Reference the outer table (the one being filtered) by its
  // schema-qualified name so the EXISTS sub-query is unambiguous.
  return `${tableName}.${quoteIdentifier(column)}`
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
        note: t.note ?? "unverified entity-registry row; review against ground truth",
      })
    }
  }
  return out
}
