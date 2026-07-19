/**
 * Entity registry types — Phase 0 of the config uplift.
 *
 * `EntityDefinition` replaces the compile-time `EntityType` union and the
 * static recipe-era metadata files. It is runtime data: created and
 * edited by tenant admins via the wizard UI, versioned (every edit produces
 * a new immutable version), referenced by every Plan / EvidenceEnvelope by
 * `entityDefVersionId` so "what did the system think this entity was when
 * it ran the sync" is always answerable.
 *
 * Storage layer lives in `packages/server/src/infra/persistence/db/entity-registry.ts`. Recipe
 * projection (Definition → Recipe) lives in `packages/sync/src/
 * entity-registry/projector.ts`.
 *
 * Design decisions locked in (see /memories/session/plan.md):
 *   D1: DB-authoritative + bidirectional YAML import/export.
 *   D2: Versioned records — every save is a new immutable version.
 *   D3: SCD2 handling is hybrid — strategies at template level, per-entity
 *       and per-table overrides.
 */

// ── Scope discriminated union ────────────────────────────────────

/**
 * How rows belonging to one entity instance are identified in a given table.
 *
 * `rootPk`  — the table has a direct FK column whose value equals the root's
 *             id (the most common case).
 * `sql`     — SQL predicate using `{id}` (single id) or `{ids}` (recursive-CTE
 *             expanded id set when the root has a self-join column). Covers
 *             multi-hop EXISTS joins and any scope not expressible as rootPk.
 */
export type EntityTableScope =
  | { kind: "rootPk"; column: string }
  | { kind: "sql"; predicate: string }
  /** @deprecated Legacy import only — normalized to `sql` on read/save. */
  | { kind: "fkPath"; through: EntityFkHop[] }

export interface EntityFkHop {
  /** Schema-qualified table name traversed. */
  table: string
  /** Column on the previous hop (or root) whose value is matched. */
  fromColumn: string
  /** Column on `table` that holds the matching value. */
  toColumn: string
}

// ── SCD2 strategy ────────────────────────────────────────────────

/**
 * Named, reusable column-handling rules for tables with SCD2 / audit-column
 * conventions. Strategies are themselves versioned records — an
 * `EntityDefinition` pins to a specific `(strategyId, strategyVersion)` pair
 * (or to a strategy id with `latest` semantics, declared explicitly).
 */
export interface Scd2Strategy {
  /** Stable machine id chosen at creation; immutable. */
  id: string
  displayName: string
  description: string
  /**
   * Columns excluded from row-hash comparison and not copied from source on update.
   * Single source of truth — no separate validity/meta role fields.
   */
  excludeFromDiff: string[]
  /**
   * Per-column expressions evaluated on the target at INSERT.
   * Keys are column names; values are raw SQL expressions for the target dialect.
   */
  onInsert: Record<string, string>
  /** Per-column expressions evaluated on the target at UPDATE (matched rows). */
  onUpdate: Record<string, string>
  /**
   * Identity PK handling during MERGE insert branch:
   *   none — copy identity from source like any other column, no IDENTITY_INSERT wrapper
   *   setIdentityInsertOn — wrap MERGE with SET IDENTITY_INSERT ON/OFF when target has identity PK
   *   omit-identity-column — never insert into the identity column
   */
  identityHandling: "none" | "setIdentityInsertOn" | "omit-identity-column"
  /** Where this strategy came from. */
  provenance: Scd2StrategyProvenance
  /** Monotonic version (bumped on every save). */
  version: number
  /** Optional human label (e.g. "v2 — fixed identity handling"). */
  versionLabel: string | null
  /** UPN of the editor who created this version. */
  createdBy: string
  /** ISO-8601. */
  createdAt: string
}

export type Scd2StrategyProvenance =
  | { kind: "bundled"; templateId: string }
  | { kind: "manual" }
  | { kind: "imported"; sourceManifestId: string }

/**
 * Effective per-table column handling after merging strategy + entity-level
 * overrides + per-table overrides. Computed by the projector at recipe-
 * projection time and snapshotted into the resulting `Recipe` so executes
 * are reproducible even if the underlying strategy/entity evolves.
 */
export interface EffectiveScd2 {
  excludeFromDiff: string[]
  onInsert: Record<string, string>
  onUpdate: Record<string, string>
  identityHandling: Scd2Strategy["identityHandling"]
  /** Resolution trace — which layer contributed each field (for diagnostics). */
  resolution: {
    strategyId: string
    strategyVersion: number
    entityOverrideApplied: boolean
    tableOverrideApplied: boolean
  }
}

// ── Entity table + definition ────────────────────────────────────

/**
 * Optional partial override applied at the entity level (overlays the
 * strategy) or per-table (overlays both). `null` on any field means
 * "fall through to the layer below"; `undefined` keys also fall through.
 * Use `[]` for an explicit empty list (e.g. clear an excluded-columns list).
 */
export interface Scd2Override {
  excludeFromDiff?: string[]
  identityHandling?: Scd2Strategy["identityHandling"]
  onInsert?: Record<string, string>
  onUpdate?: Record<string, string>
}

export type EntityTableProvenance =
  | { kind: "manual" }
  | { kind: "template"; templateId: string; entityId: string }
  | { kind: "sproc"; sprocName: string; lineRange?: [number, number] }
  | { kind: "importer"; importerId: string }
  | { kind: "fkGraphSuggester"; confidence: "high" | "medium" | "low" }

/**
 * How an `EntityTable` row was discovered / validated. Mirrors the fields in
 * the legacy recipe-era model so the registry remains a faithful superset of
 * the historical introspection output.
 */
export type EntityTableSource =
  | "fk+pipeline" // both FK graph and legacy pipeline agree
  | "fk-only" // only FK graph; predicate inferred, needs verification
  | "pipeline-only" // only legacy pipeline body referenced it
  | "manual" // hand-authored

export interface EntityTable {
  /** Schema-qualified name e.g. `core.ContractColumn`. */
  name: string
  scope: EntityTableScope
  /** Integer order; parents (lower) first for upsert, reversed for delete. */
  executionOrder: number
  /** Optional per-table SCD2 strategy override (merged on top of entity-level). */
  scd2Override: Scd2Override | null
  /** True when the recipe row has been reviewed against ground truth. */
  verified: boolean
  /** Optional schema-qualified archive table name (e.g. `coreArchive.Contract`). */
  archiveTable: string | null
  /** Free-form note (esp. for unverified rows or scope decisions). */
  note: string | null
  /** Where this row was discovered. */
  provenance: EntityTableProvenance

  // ── Enriched introspection fields (additive, all nullable) ──────
  // Source FK column name even when the scope is expressed as raw SQL
  // (e.g. `contractId` for a `core.Pipeline` row whose predicate joins
  // through a parent table). Used by the UI to render "Scope: rootPk
  // · contractId" or for analytics that need to group by the original
  // FK column without parsing the SQL.
  scopeColumn: string | null
  /** How this table was discovered (FK graph, legacy pipeline, etc.). */
  source: EntityTableSource | null
  /** True if a legacy MyMI pipeline body confirmed this table belongs. */
  groundedByPipeline: boolean | null
  /** Whether this table is included in a sync run by default. */
  enabledByDefault: boolean | null
  /** Whether the operator can toggle this table on/off in the UI. */
  userControllable: boolean | null
}

export interface EntityPolicies {
  /** When active, block sync execute unless operator overrides (see freeze-windows evaluator). */
  freezeWindowIds: string[]
}

export interface EntityLineageRef {
  /** Schema-qualified downstream artifact e.g. `publish.Revenue`. */
  object: string
  /** What kind of dependency (matches LineageRef.kind in P0.9). */
  kind: "view-source" | "report-source" | "downstream-consumer"
  note: string | null
}

export type EntityDefinitionProvenance =
  | { kind: "manual" }
  | { kind: "template"; templateId: string; templateVersion: number }
  | { kind: "legacy-migration"; legacyPipelineId: number | null }
  | { kind: "imported"; sourceManifestId: string }

/**
 * The canonical runtime shape. Read from the registry; never written
 * directly — saves go through the storage layer which produces a new
 * `EntityDefinitionVersion` row atomically.
 */
export interface EntityDefinition {
  /** Stable machine id chosen at creation; immutable across versions. */
  id: string
  /** Tenant scope. Single-tenant deployments use the sentinel `_default`. */
  tenantId: string
  displayName: string
  description: string
  /** Schema-qualified root table. */
  rootTable: string
  /** PK column on the root (e.g. `contractId`). */
  idColumn: string
  /** Column used as a human display label in pickers (e.g. `name`). */
  labelColumn: string | null
  /**
   * Self-referencing FK column on the root, if any. When set, the projector
   * expands a single root id to the full descendant tree via recursive CTE
   * before instantiating per-table predicates. Mirrors the legacy
   * `selfJoinColumn` on `SyncRecipe`.
   */
  selfJoinColumn: string | null
  tables: EntityTable[]
  policies: EntityPolicies
  /**
   * Entity-level SCD2 strategy reference. `strategyId` is required; version
   * may be a specific integer (pinned) or `"latest"` (track current).
   */
  scd2: {
    strategyId: string
    strategyVersion: number | "latest"
    entityOverride: Scd2Override | null
  }
  lineageRefs: EntityLineageRef[]
  provenance: EntityDefinitionProvenance
  /**
   * Flow in sync-metadata that defines execution steps for this entity.
   * Publish resolves steps from this id; tip has no other run bindings.
   */
  flowId: string

  // ── Enriched introspection fields (additive, all optional) ───────
  /** Legacy MyMI entry-point stored procedure name (if migrated). */
  legacyEntrySproc: string | null
  /**
   * Explicit reverse-order override (for deletes). When empty, the projector
   * computes the reverse of `tables.executionOrder` automatically.
   */
  reverseOrder: string[]
  /**
   * Diagnostic notes captured during introspection (e.g. "Step.scopeColumn
   * inferred; verify against sproc body"). Free-form, surfaced in the UI.
   */
  discrepancies: string[]

  /** Monotonic version (bumped on every save). */
  version: number
  /** Optional human label for the version. */
  versionLabel: string | null
  /** UPN of the editor who created this version. */
  createdBy: string
  /** Required reason text captured on save. */
  reason: string
  /** ISO-8601 timestamp of save. */
  createdAt: string
  /** Soft-retire timestamp; entity becomes hidden from active lists but
   *  historical evidence still resolves. */
  retiredAt: string | null
}

/**
 * Discriminated kind of structural change between two versions of the same
 * entity, used for diff display + evidence envelopes.
 */
export type EntityDefinitionChangeKind =
  | "created"
  | "renamed"
  | "rootTableChanged"
  | "idColumnChanged"
  | "scopeChanged"
  | "scd2StrategyChanged"
  | "scd2OverrideChanged"
  | "tableAdded"
  | "tableRemoved"
  | "tableReordered"
  | "verifiedFlagChanged"
  | "policiesChanged"
  | "lineageChanged"
  | "retired"
  | "unretired"

export interface EntityDefinitionChange {
  kind: EntityDefinitionChangeKind
  /** Table name when the change is table-scoped, else null. */
  tableName: string | null
  /** Short human description e.g. "executionOrder: 3 → 5". */
  description: string
  /** Optional structured before/after pair for machine consumers. */
  before?: unknown
  after?: unknown
}

// ── Validation ───────────────────────────────────────────────────

/** Structural validation outcome (run on every save before persistence). */
export interface ValidationResult {
  ok: boolean
  errors: ValidationError[]
  warnings: ValidationWarning[]
}

export interface ValidationError {
  code: ValidationErrorCode
  message: string
  /** JSON-pointer-style path into the definition (e.g. `/tables/2/scope`). */
  path: string
}

export interface ValidationWarning {
  code: string
  message: string
  path: string
}

export type ValidationErrorCode =
  | "id_invalid"
  | "id_reserved"
  | "tenant_missing"
  | "root_table_invalid"
  | "id_column_missing"
  | "table_name_invalid"
  | "table_duplicate"
  | "table_missing"
  | "execution_order_cycle"
  | "execution_order_duplicate"
  | "scope_invalid"
  | "scope_incomplete"
  | "scope_deprecated"
  | "scope_degraded_legacy"
  | "scope_sql_unsafe"
  | "predicate_drift"
  | "scd2_strategy_unknown"
  | "scd2_strategy_version_unknown"
  | "freeze_window_unknown"
  | "lineage_object_invalid"
  | "version_not_positive"

// ── Reserved ids ─────────────────────────────────────────────────

/**
 * Entity ids that are reserved at the platform level (cannot be used as
 * tenant entity ids). Keeps namespace clean for future internal entities.
 */
export const RESERVED_ENTITY_IDS = Object.freeze(["_internal", "_system", "_meta"] as const)

/** Single-tenant sentinel tenant id used when multi-tenancy is off. */
export const DEFAULT_TENANT_ID = "_default"

// ── Identifier validation ────────────────────────────────────────

/**
 * Machine ids (entity id, strategy id, tenant id) must match this pattern.
 * Lower-snake-case, 1-64 chars, alpha first, alnum + underscore + hyphen.
 * The leading-alpha rule keeps ids safe to use as YAML keys and URL segments.
 *
 * Reserved ids (RESERVED_ENTITY_IDS) start with `_` and bypass this rule
 * — they are intentionally constructed to be invalid for user input so the
 * regex acts as a second line of defence.
 */
export const ID_PATTERN = /^[a-z][a-zA-Z0-9_-]{0,63}$/

export function isValidId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value)
}
