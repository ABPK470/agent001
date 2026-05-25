/**
 * Sync recipes — curated, per-entity-type sync metadata.
 *
 * Output of the introspection script (`scripts/introspect-sync-pipelines.mjs`)
 * which reverse-engineers ABI's legacy stored-procedure sync pipelines (788,
 * 692, 780, 791, 792, 798) into a declarative recipe consumed by the runtime
 * sync engine.
 *
 * Each recipe describes:
 *   - the root entity table (e.g. `core.Contract`)
 *   - the FK column that scopes a single entity instance
 *   - the ordered list of dependent tables to sync
 *   - per-table scope predicate (how to restrict rows for a given entity id)
 *   - reconciliation flags (verified / fk-only / pipeline-only) for transparency
 *   - the matching `coreArchive` / `gateArchive` tables (if any)
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { AgentHost } from "../host/index.js"

/**
 * Identifier for a sync entity. Originally a closed string union
 * (contract / dataset / rule / pipelineActivity / gateMetadata / content);
 * Phase 0 of the entity-registry uplift lifts this to `string` so tenants
 * can register additional entities at runtime. The canonical set still
 * defines first-class behaviour, but is no longer enforced at compile
 * time — validation happens at the registry boundary.
 */
export type EntityType = string

/** The historically-bundled entity ids (informational; not enforced). */
export const BUNDLED_ENTITY_IDS = [
  "contract",
  "dataset",
  "rule",
  "pipelineActivity",
  "gateMetadata",
  "content",
] as const

/** How a given table was discovered as part of an entity's dependency closure. */
import { DiscoverySource, SyncRecipeDiscrepancyKind } from "../domain/enums/sync.js"
export type { DiscoverySource }

export interface SyncRecipeTable {
  /** Schema-qualified name e.g. `core.ContractColumn`. */
  name: string
  /** Column the entity id binds to e.g. `contractId`. NULL = whole table (rare). */
  scopeColumn: string | null
  /**
   * Predicate template used by the diff engine. `{id}` is substituted with the
   * entity id. If `scopeColumn` is set this is auto-derived as `{scopeColumn} = {id}`.
   * Custom predicates (e.g. EXISTS sub-queries) are supported for indirect dependencies.
   */
  predicate: string
  /** How this table was discovered. */
  source: DiscoverySource
  /** True when both FK closure and live pipeline introspection agree. */
  verified: boolean
  /** True when the legacy pipeline explicitly touches this table. */
  groundedByPipeline?: boolean
  /** Whether this table is included unless the user opts out. */
  enabledByDefault?: boolean
  /** Whether the user may explicitly enable/disable this table for a preview. */
  userControllable?: boolean
  /** Free-form note explaining why the row exists (esp. for unverified rows). */
  note?: string
}

export interface SyncRecipeDiscrepancy {
  table: string
  /**
   * `leak`     — table is FK-reachable but the legacy pipeline doesn't touch it
   *              (legacy bug; our engine still syncs it).
   * `implicit` — table is touched by the legacy pipeline but not FK-reachable
   *              from the root (e.g. via dynamic SQL); manually verified.
   * `drift`    — pipeline references a table that doesn't exist in the catalog.
   */
  kind: SyncRecipeDiscrepancyKind
  note: string
}

export interface SyncRecipe {
  entityType: EntityType
  /** Human display name e.g. "Contract". */
  displayName: string
  /** Schema-qualified root table e.g. `core.Contract`. */
  rootTable: string
  /** PK column of the root table e.g. `contractId`. */
  rootKeyColumn: string
  /** Optional name column for friendly display in pickers e.g. `Name`. */
  rootNameColumn: string | null
  /** Legacy pipeline id this recipe replaces, for documentation. */
  legacyPipelineId: number | null
  /**
   * When the root table has a self-referencing FK (e.g. `core.Rule.parentRuleId`
   * → `core.Rule.ruleId`), set this to the FK column name. The sync engine will
   * expand the single `{id}` to the full tree of IDs via a recursive CTE before
   * instantiating predicates, so all descendant rows are included in the diff.
   *
   * Predicates that should receive the expanded set use `{ids}` instead of `{id}`.
   * Predicates using `{id}` remain bound to the single root entity ID.
   */
  selfJoinColumn: string | null
  /** All tables in dependency order (parents before children). */
  tables: SyncRecipeTable[]
  /** Tables to drop from in reverse order on a DELETE-cascade — auto-derived. */
  executionOrder: string[]
  /** Reverse — children first, parents last — used for delete-on-target operations. */
  reverseOrder: string[]
  /**
   * Per-table SCD2 archive table (e.g. `coreArchive.Contract` for `core.Contract`).
   * Populated by convention (`{schema}Archive.{name}`) when not explicitly set.
   * Set to `null` when the source table has no archive sibling.
   * Order matches `tables[]` 1:1 — index-aligned.
   */
  archiveTables: Array<string | null>
  /** Discrepancies surfaced during introspection. */
  discrepancies: SyncRecipeDiscrepancy[]
  /** When this recipe was last regenerated (ISO-8601). */
  generatedAt: string
}

export interface SyncRecipeBundle {
  /** Schema version of this artifact. Bump on breaking changes. */
  version: 1
  generatedAt: string
  /** Source connection used during introspection (for traceability). */
  introspectedFrom: string | null
  recipes: Record<EntityType, SyncRecipe | null>
}

export interface ActiveSyncRecipeSelection {
  tables: SyncRecipeTable[]
  executionOrder: string[]
  reverseOrder: string[]
}

// ── Loading ──────────────────────────────────────────────────────

const DEFAULT_RECIPES_PATH = "deploy/mssql/sync-recipes.json"

// State container — `const` reference to a mutable record so the lint rule
// banning module-level `let` passes while preserving the existing singleton
// shape. The state can be migrated into AgentRuntime sub-runtimes later.

/**
 * Load the sync-recipes bundle from disk. Caches in memory.
 *
 * @param projectRoot Absolute project root.
 * @param relPath     Optional override; defaults to `deploy/mssql/sync-recipes.json`.
 * @returns The bundle, or an empty placeholder if the file does not exist.
 */
export function loadSyncRecipes(host: AgentHost, projectRoot: string, relPath = DEFAULT_RECIPES_PATH): SyncRecipeBundle {
  const recipes = host.sync.recipes
  if (recipes.bundle && recipes.loadedFromPath === relPath) return recipes.bundle
  const full = resolve(projectRoot, relPath)
  if (!existsSync(full)) {
    const bundle = emptyBundle()
    recipes.bundle = bundle
    recipes.loadedFromPath = relPath
    return bundle
  }
  try {
    const raw = readFileSync(full, "utf-8")
    const parsed = JSON.parse(raw) as SyncRecipeBundle
    if (parsed.version !== 1) {
      throw new Error(`Unsupported sync-recipes version: ${parsed.version}`)
    }
    // Populate archiveTables by convention when missing.
    for (const [, recipe] of Object.entries(parsed.recipes)) {
      if (!recipe) continue
      recipe.tables = recipe.tables.map(normalizeRecipeTable)
      if (!Array.isArray(recipe.archiveTables)) {
        recipe.archiveTables = recipe.tables.map((t) => deriveArchiveTable(t.name))
      }
    }
    recipes.bundle = parsed
    recipes.loadedFromPath = relPath
    return parsed
  } catch (e) {
    console.warn(`Failed to load sync-recipes from ${full}:`, e instanceof Error ? e.message : e)
    const bundle = emptyBundle()
    recipes.bundle = bundle
    recipes.loadedFromPath = relPath
    return bundle
  }
}

/** Force a reload on next call (e.g. after the introspection script ran). */
export function clearSyncRecipesCache(host: AgentHost): void {
  host.sync.recipes.bundle = null
  host.sync.recipes.loadedFromPath = null
}

/** Return a recipe by entity type. Throws if unknown or not introspected yet. */
export function getRecipe(bundle: SyncRecipeBundle, type: EntityType): SyncRecipe {
  const r = bundle.recipes[type]
  if (!r) {
    throw new Error(
      `No sync recipe defined for entity type "${type}". ` +
      `Run the introspection script (scripts/introspect-sync-pipelines.mjs) ` +
      `against a live source DB to populate deploy/mssql/sync-recipes.json.`,
    )
  }
  return r
}

export function selectRecipeTables(
  recipe: SyncRecipe,
  enabledOptionalTables: string[] | undefined,
): ActiveSyncRecipeSelection {
  const enabledOptional = new Set(enabledOptionalTables ?? [])
  const tables = recipe.tables.filter((table) => isRecipeTableEnabled(table, enabledOptional))
  const activeNames = new Set(tables.map((table) => table.name))
  return {
    tables,
    executionOrder: recipe.executionOrder.filter((tableName) => activeNames.has(tableName)),
    reverseOrder: recipe.reverseOrder.filter((tableName) => activeNames.has(tableName)),
  }
}

function emptyBundle(): SyncRecipeBundle {
  return {
    version: 1,
    generatedAt: new Date(0).toISOString(),
    introspectedFrom: null,
    // Recipes is a string-keyed map now; entries are populated by the
    // introspector + entity registry. Empty initial map is fine.
    recipes: {},
  }
}

function normalizeRecipeTable(table: SyncRecipeTable): SyncRecipeTable {
  const groundedByPipeline = table.groundedByPipeline ?? table.source !== DiscoverySource.FkOnly
  const userControllable = table.userControllable ?? !groundedByPipeline
  const enabledByDefault = table.enabledByDefault ?? !userControllable
  return {
    ...table,
    groundedByPipeline,
    userControllable,
    enabledByDefault,
  }
}

function isRecipeTableEnabled(table: SyncRecipeTable, enabledOptional: Set<string>): boolean {
  const normalized = normalizeRecipeTable(table)
  if (!normalized.userControllable) return normalized.enabledByDefault !== false
  return enabledOptional.has(normalized.name) || normalized.enabledByDefault === true
}

// ── Predicate helpers ────────────────────────────────────────────

/** Substitute `{id}` placeholders in a predicate template. */
export function instantiatePredicate(predicate: string, entityId: string | number): string {
  // Quote string ids; numerics pass through.
  const literal =
    typeof entityId === "number"
      ? String(entityId)
      : `'${String(entityId).replace(/'/g, "''")}'`
  return predicate.replace(/\{id\}/g, literal)
}

/**
 * Substitute both `{id}` (single root) and `{ids}` (expanded tree) placeholders.
 * When `expandedIds` is null or empty, `{ids}` falls back to the single `{id}`.
 */
export function instantiatePredicateWithTree(
  predicate: string,
  entityId: string | number,
  expandedIds: Array<string | number> | null,
): string {
  const literal =
    typeof entityId === "number"
      ? String(entityId)
      : `'${String(entityId).replace(/'/g, "''")}'`

  // Build the {ids} literal list — e.g. "1, 2, 3" or "'a', 'b'"
  const effectiveIds = expandedIds && expandedIds.length > 0 ? expandedIds : [entityId]
  const idsLiteral = effectiveIds.map((id) =>
    typeof id === "number" ? String(id) : `'${String(id).replace(/'/g, "''")}'`,
  ).join(", ")

  return predicate
    .replace(/\{ids\}/g, idsLiteral)
    .replace(/\{id\}/g, literal)
}

// ── Archive table derivation ─────────────────────────────────────

/**
 * Map a source table to its SCD2 archive sibling by convention:
 *   `core.Contract`   → `coreArchive.Contract`
 *   `gate.Content`    → `gateArchive.Content`
 *   `master.Anything` → null (no archive sibling by ABI convention)
 *
 * The convention is data-driven: the runtime resolves the actual archive table
 * by checking catalog existence — see `resolveArchiveTable()` in
 * sync/orchestrator.ts. This helper just supplies a starting candidate.
 */
export function deriveArchiveTable(qualifiedName: string): string | null {
  const [schema, name] = qualifiedName.split(".")
  if (!schema || !name) return null
  if (schema === "master") return null
  if (schema.endsWith("Archive")) return null // already an archive
  return `${schema}Archive.${name}`
}
