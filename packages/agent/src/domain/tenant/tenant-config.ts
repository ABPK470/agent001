/**
 * Tenant configuration — the single source of truth for per-deployment
 * business knobs.
 *
 * Everything customer-specific that USED to be hardcoded across the agent
 * (table-name regexes, schema-tier rankings, branch-aggregation thresholds,
 * mirror-schema names, etc.) lives here. Defaults ship values that keep
 * the agent's existing behaviour bit-identical for the canonical
 * deployment; new deployments override via the `MIA_TENANT_CONFIG` env
 * var pointing at a JSON file.
 *
 * Design principles:
 *   • One frozen singleton, loaded once at startup; no mutation thereafter.
 *   • Every knob has a sane default — empty config is valid.
 *   • Keep the schema MINIMAL — every key here is a piece of business
 *     knowledge that the catalog cannot supply (thresholds, naming
 *     conventions, routing keywords).
 *   • NEVER put table or column names in defaults. If a name appears here,
 *     it must be either a pattern token (e.g. an alias prefix family) or
 *     a routing hint that a tenant overrode explicitly.
 */

import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"


export interface CatalogBootstrapMetadata {
  largeObjects: ReadonlyArray<string>
  canonicalQualifiedNames: Readonly<Record<string, string>>
  unionBranchCounts: Readonly<Record<string, number>>
  highCardinalityKeys: Readonly<Record<string, ReadonlyArray<string>>>
}

export const DEFAULT_CATALOG_BOOTSTRAP: CatalogBootstrapMetadata = Object.freeze({
  largeObjects: [],
  canonicalQualifiedNames: Object.freeze({}),
  unionBranchCounts: Object.freeze({}),
  highCardinalityKeys: Object.freeze({})
})

// ── Schema ──────────────────────────────────────────────────────

export interface TenantConfig {
  /** rowCount (or viewSourceRows) threshold above which an object is "large". */
  largeObjectRows: number
  /** UNION-branch count above which a view's TOP-N+GROUP-BY needs branch-aggregation. */
  unionBranchThreshold: number

  /**
   * Per-schema ranking weight for catalog search. Schemas listed here get
   * the assigned boost; unlisted schemas get 0.
   *
   * NB: this is intentionally a list of {schema, weight} pairs rather than
   * an object literal — schema names are tenant-specific and we don't want
   * defaults that bake in any one customer's naming convention. Default is
   * the empty list (no ranking — search is pure relevance).
   */
  schemaRanking: ReadonlyArray<{ schema: string; weight: number }>

  /**
   * Schema prefix for materialised mirrors of views. When set, the
   * "prefer mirror over base" doctrine activates: `<mirrorSchema>.<base>`
   * is checked for each large base view and substituted into queries.
   * Default: null (no mirror convention).
   */
  mirrorSchema: string | null

  /**
   * User-facing business vocabulary for this warehouse — words people actually
   * type in goals ("revenue", "rwa", "africaflex"). Used for goal gating and
   * clarify. NOT internal entity IDs (those come from the published sync bundle).
   */
  domainKeywords: ReadonlyArray<string>

  /**
   * Optional pre-catalog metadata for deployments/tests that need known
   * object hints before a live catalog is loaded.
   */
  catalogBootstrap: CatalogBootstrapMetadata

  /**
   * Regex token alternatives matching pre-aggregation column tokens,
   * e.g. ("MTD", "YTD", "QTD", "WTD"). Compiled into a single
   * case-insensitive alternation by validation.ts. Default: empty.
   */
  preAggregationTokens: ReadonlyArray<string>

  /**
   * Alias-prefix families used by validation's `detectAggregationOnAlias`
   * to recognise when an aggregate column name implies the aggregate
   * function (e.g. "Sum" → SUM, "Avg" → AVG). Defaults cover the
   * statistical aggregates supported by MSSQL; tenants can extend
   * with custom prefixes (e.g. "NetRev", "GrossRev").
   */
  aliasFamilies: ReadonlyArray<{ prefix: string; aggregate: string }>

  /**
   * Schema and short-noun tokens reserved by the catalog and therefore
   * disallowed as SQL aliases (because aliasing a schema name confuses
   * the static SQL validator). Default: empty — populated from
   * `listSchemas()` at validator-time when needed.
   */
  reservedAliases: ReadonlyArray<string>
}

// ── Defaults ────────────────────────────────────────────────────
//
// These values are universal, not customer-specific. They reproduce the
// agent's pre-tenant-config behaviour for warehouses where no
// per-deployment override is supplied.

export const DEFAULT_TENANT_CONFIG: TenantConfig = Object.freeze({
  largeObjectRows: 10_000_000,
  unionBranchThreshold: 8,
  schemaRanking: [],
  mirrorSchema: null,
  catalogBootstrap: DEFAULT_CATALOG_BOOTSTRAP,
  domainKeywords: [],
  preAggregationTokens: [
    // Snapshot / point-in-time / pre-averaged columns whose row values
    // CANNOT be SUMmed without double-counting. Tenant-overridable.
    //
    // INTENTIONALLY NOT INCLUDED: MTD / YTD / QTD / WTD. In this and
    // similar MyMI-style warehouses, those suffixes denote row-grain
    // *period-slice* metrics (one row per business key per period;
    // SUM across rows for a single pkMonth/pkYear is the correct
    // period total). A tenant whose `…MTD` columns are instead a
    // cumulative running total should override this list at startup.
    "Average",
    "Avg",
    "Mean",
    "Median",
    "Spot",
    "EOM",
    "Eod",
    "Latest",
    "Snapshot",
    "EndOf",
    "AsOf",
    "StartOf"
  ],
  aliasFamilies: [
    { prefix: "Sum", aggregate: "SUM" },
    { prefix: "Total", aggregate: "SUM" },
    { prefix: "Avg", aggregate: "AVG" },
    { prefix: "Mean", aggregate: "AVG" },
    { prefix: "Min", aggregate: "MIN" },
    { prefix: "Max", aggregate: "MAX" },
    { prefix: "Count", aggregate: "COUNT" }
  ],
  reservedAliases: []
}) as TenantConfig

// ── Singleton + loader ──────────────────────────────────────────

const tenantConfigState = {
  active: DEFAULT_TENANT_CONFIG as TenantConfig
}

/** Returns the live tenant config. Cheap — just returns the singleton. */
export function getTenantConfig(): TenantConfig {
  return tenantConfigState.active
}

/**
 * Replace the active tenant config. The new value is deep-frozen and
 * merged onto defaults so partial overrides are safe.
 *
 * Intended for: (a) `loadTenantConfigFromEnv()` at startup, (b) tests
 * (`setTenantConfig({...})`).
 */
export function setTenantConfig(overrides: Partial<TenantConfig>): TenantConfig {
  tenantConfigState.active = freezeDeep(mergeWithDefaults(overrides))
  return tenantConfigState.active
}

/** Reset to factory defaults. Tests call this in `afterEach`. */
export function resetTenantConfig(): void {
  tenantConfigState.active = DEFAULT_TENANT_CONFIG
}

/** Resolve `MIA_TENANT_CONFIG` paths relative to `baseDir` (repo root at server boot). */
export function resolveTenantConfigPath(filePath: string, baseDir: string = process.cwd()): string {
  return isAbsolute(filePath) ? filePath : resolve(baseDir, filePath)
}

/**
 * Load tenant config from a JSON file. Throws when the file is missing or
 * invalid so a misconfigured deployment fails loudly at startup.
 */
export function loadTenantConfigFromFile(
  filePath: string,
  options: { baseDir?: string } = {}
): TenantConfig {
  const resolved = resolveTenantConfigPath(filePath, options.baseDir ?? process.cwd())
  if (!existsSync(resolved)) {
    throw new Error(`Tenant config file not found: ${resolved}`)
  }
  const raw = readFileSync(resolved, "utf8")
  const parsed = JSON.parse(raw) as Partial<TenantConfig>
  return setTenantConfig(parsed)
}

/**
 * Load tenant config from the file path in `MIA_TENANT_CONFIG`. Returns
 * defaults when the env var is unset. Throws on parse / missing-file error.
 */
export function loadTenantConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: { baseDir?: string } = {}
): TenantConfig {
  const path = env.MIA_TENANT_CONFIG
  if (!path) return DEFAULT_TENANT_CONFIG
  return loadTenantConfigFromFile(path, options)
}

/** One-line boot summary for server startup logs. */
export function formatTenantConfigBootSummary(c: TenantConfig = getTenantConfig()): string {
  const mirror = c.mirrorSchema ?? "none"
  const bootstrap = c.catalogBootstrap.largeObjects.length
  return [
    `mirror=${mirror}`,
    `domainKeywords=${c.domainKeywords.length}`,
    `schemaRanking=${c.schemaRanking.length}`,
    `largeObjectRows=${c.largeObjectRows}`,
    `unionBranchThreshold=${c.unionBranchThreshold}`,
    `preAggTokens=${c.preAggregationTokens.length}`,
    `aliasFamilies=${c.aliasFamilies.length}`,
    `reservedAliases=${c.reservedAliases.length}`,
    `catalogBootstrapObjects=${bootstrap}`
  ].join(", ")
}

// ── Internals ──────────────────────────────────────────────────

function mergeWithDefaults(o: Partial<TenantConfig>): TenantConfig {
  return {
    largeObjectRows: o.largeObjectRows ?? DEFAULT_TENANT_CONFIG.largeObjectRows,
    unionBranchThreshold: o.unionBranchThreshold ?? DEFAULT_TENANT_CONFIG.unionBranchThreshold,
    schemaRanking: o.schemaRanking ?? DEFAULT_TENANT_CONFIG.schemaRanking,
    mirrorSchema: o.mirrorSchema ?? DEFAULT_TENANT_CONFIG.mirrorSchema,
    catalogBootstrap: o.catalogBootstrap ?? DEFAULT_TENANT_CONFIG.catalogBootstrap,
    domainKeywords: o.domainKeywords ?? DEFAULT_TENANT_CONFIG.domainKeywords,
    preAggregationTokens: o.preAggregationTokens ?? DEFAULT_TENANT_CONFIG.preAggregationTokens,
    aliasFamilies: o.aliasFamilies ?? DEFAULT_TENANT_CONFIG.aliasFamilies,
    reservedAliases: o.reservedAliases ?? DEFAULT_TENANT_CONFIG.reservedAliases
  }
}

function freezeDeep<T>(v: T): T {
  if (v == null || typeof v !== "object") return v
  for (const k of Object.keys(v as object).sort()) {
    freezeDeep((v as Record<string, unknown>)[k])
  }
  return Object.freeze(v)
}

// ── Diagnostic ────────────────────────────────────────────────

/**
 * Convenience for callers that want a one-line "is this the default
 * config?" check (e.g. doctrine modules logging the active config).
 */
export function isDefaultTenantConfig(c: TenantConfig = getTenantConfig()): boolean {
  return isDeepStrictEqual(c, DEFAULT_TENANT_CONFIG)
}
