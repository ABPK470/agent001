/**
 * Persistence for the entity registry — entity definitions + SCD2
 * strategies, both versioned.
 *
 * Storage shape (see migrations/0001_baseline.ts for DDL):
 *
 *   entity_active(tenant_id, id) → current_version + retired_at
 *   entity_versions(tenant_id, id, version) → immutable history row
 *     containing the full EntityDefinition JSON + the structured diff
 *     against the prior version.
 *
 *   scd2_strategy_active / scd2_strategy_versions follow the same pattern.
 *   Convention: `*_active` = current-version cursor; document body lives in `*_versions`.
 *
 * Save semantics:
 *   - Every save inserts a *new* row in *_versions (append-only — DB
 *     triggers refuse UPDATE/DELETE) and advances the pointer in a
 *     single transaction.
 *   - The new row's `version` is `current_version + 1` (or 1 for the
 *     first save).
 *   - The reason + actor go on the version row, not the pointer row, so
 *     history reads can attribute every change.
 *   - Retire = update pointer row with `retired_at`. The entity remains
 *     resolvable for historical reads.
 *
 * Validation is enforced by `validateEntityDefinition` /
 * `validateScd2Strategy` from `@mia/sync` (structural only — catalog
 * validation happens later in the orchestrator).
 */

import {
  asFlowId,
  asTenantId,
  DEFAULT_TENANT_ID,
  diffEntityDefinitions,
  normalizeEntityDefinition as normalizeEntityCanonical,
  normalizeScd2Strategy,
  validateEntityDefinition,
  validateScd2Strategy,
  type EntityDefinition,
  type Scd2Strategy,
  type ValidationResult
} from "@mia/sync"
import { getDb } from "../connection.js"
import { getPlatformStore } from "../platform-store.js"
import { runAllAsync, runExecAsync, runGetAsync } from "../../../schema/execute-async.js"
import { getPlatformDb } from "../../../schema/kysely.js"
import { listFreezeWindowsForTenant } from "./freeze-windows.js"

import {
  mergesBundledStrategies,
  strategyHistoryTenants,
  strategyResolutionTenants
} from "./tenant-inheritance.js"

function parseStoredStrategy(body: string): Scd2Strategy {
  return normalizeScd2Strategy(JSON.parse(body) as Scd2Strategy)
}

/**
 * Forward-compatible normalizer.
 *
 * When the EntityDefinition schema is enriched (e.g. adding the
 * `discrepancies` / `reverseOrder` / `legacyEntrySproc` fields or
 * per-table introspection fields), older rows that were written to
 * `entity_versions` before the migration are missing those keys.
 * Returning the raw JSON would surface as runtime `undefined.length`
 * crashes in any consumer that treats the new fields as required.
 *
 * This normalizer applies *additive*, non-destructive defaults at the
 * read boundary so the in-memory shape always matches the current
 * TypeScript types. It does NOT rewrite stored rows — the next save of
 * an entity will persist the canonical shape naturally.
 */
function normalizeEntityDefinition(raw: EntityDefinition): EntityDefinition {
  const r = raw as Partial<EntityDefinition> & EntityDefinition
  return normalizeEntityCanonical({
    ...r,
    tables: (r.tables ?? []).map(normalizeEntityTable),
    flowId: asFlowId(typeof r.flowId === "string" && r.flowId.trim() !== "" ? r.flowId : r.id),
    legacyEntrySproc: r.legacyEntrySproc ?? null,
    reverseOrder: r.reverseOrder ?? [],
    discrepancies: r.discrepancies ?? [],
  })
}

function normalizeEntityTable(t: EntityDefinition["tables"][number]): EntityDefinition["tables"][number] {
  const x = t as Partial<EntityDefinition["tables"][number]> & EntityDefinition["tables"][number]
  return {
    ...x,
    scopeColumn: x.scopeColumn ?? null,
    source: x.source ?? null,
    groundedByPipeline: x.groundedByPipeline ?? null,
    enabledByDefault: x.enabledByDefault ?? null,
    userControllable: x.userControllable ?? null
  }
}

// ── Cross-reference validation ──────────────────────────────────────
//
// Structural validation (`validateEntityDefinition`) cannot reach into
// the strategy / freeze-window stores. This validator runs *after*
// structural pass to guarantee that every id the entity references
// actually resolves at save time, so admins get an immediate error
// instead of a silent runtime warn-and-fallback.
//
// - scd2.strategyId + scd2.strategyVersion → resolveScd2Strategy
//                                            (tenant → _default → bundled)
// - policies.freezeWindowIds[]            → in-process registry (which
//                                            mirrors freeze_window_configs DB)
async function validateEntityReferences(tenantId: string, def: EntityDefinition): Promise<ValidationResult> {
  const errors: ValidationResult["errors"] = []
  const warnings: ValidationResult["warnings"] = []

  // strategy resolution
  const strategy = await resolveScd2Strategy(tenantId, def.scd2.strategyId, def.scd2.strategyVersion)
  if (!strategy) {
    errors.push({
      path: "scd2.strategyId",
      code: "scd2_strategy_unknown",
      message: `SCD2 strategy "${def.scd2.strategyId}" v${def.scd2.strategyVersion} does not resolve for tenant "${tenantId}". Pick one from GET /api/entity-registry/strategies, or create a custom strategy first.`
    })
  }

  // freeze windows: every referenced id must be in the in-process
  // registry (which mirrors the freeze_window_configs DB table for _default).
  if (def.policies.freezeWindowIds.length > 0) {
    const reg = await listFreezeWindowIdsForGate()
    for (const fwId of def.policies.freezeWindowIds) {
      if (!reg.has(fwId)) {
        errors.push({
          path: "policies.freezeWindowIds",
          code: "freeze_window_unknown",
          message: `freeze window "${fwId}" is not defined. Create it via GET/POST /api/sync/freeze-windows first.`
        })
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings }
}

/**
 * Tenant-agnostic gate over the agent's in-process freeze-window
 * registry. Bound at call time (not module-load) so test setups that
 * swap `installFreezeWindowRegistry` between cases see the latest set.
 */
async function listFreezeWindowIdsForGate(): Promise<Set<string>> {
  return new Set((await listFreezeWindowsForTenant(DEFAULT_TENANT_ID)).map((w) => w.id))
}

// ── Entity definitions ──────────────────────────────────────────────

export interface EntityDefinitionRecord {
  tenantId: string
  id: string
  currentVersion: number
  retiredAt: string | null
}

export interface EntityDefinitionVersionRow {
  tenantId: string
  id: string
  version: number
  versionLabel: string | null
  createdBy: string
  createdAt: string
  reason: string
}

export class EntityRegistryValidationError extends Error {
  readonly result: ValidationResult
  constructor(result: ValidationResult) {
    super(
      `entity definition failed validation: ${result.errors
        .map((e) => `${e.path} ${e.code} - ${e.message}`)
        .join("; ")}`
    )
    this.name = "EntityRegistryValidationError"
    this.result = result
  }
}

export class EntityRegistryConflictError extends Error {
  readonly id: string
  constructor(id: string, message?: string) {
    super(message ?? `entity already exists: ${id}`)
    this.name = "EntityRegistryConflictError"
    this.id = id
  }
}

export interface SaveEntityResult {
  tenantId: string
  id: string
  version: number
  diff: ReturnType<typeof diffEntityDefinitions>
}

async function selectEntityPointer(tenantId: string, id: string) {
  const compiled = getPlatformDb()
    .selectFrom("entity_active")
    .select(["current_version", "retired_at"])
    .where("tenant_id", "=", tenantId)
    .where("id", "=", id)
    .compile()
  return await runGetAsync<{ current_version: number; retired_at: string | null }>(compiled)
}

async function insertEntityVersion(row: {
  tenant_id: string
  id: string
  version: number
  body_json: string
  version_label: string | null
  created_by: string
  created_at: string
  reason: string
  diff_json: string
}): Promise<void> {
  const compiled = getPlatformDb()
    .insertInto("entity_versions")
    .values(row)
    .compile()
  await runExecAsync(compiled)
}

async function upsertEntityActivePointer(
  tenantId: string,
  id: string,
  nextVersion: number,
  hadPointer: boolean,
): Promise<void> {
  if (hadPointer) {
    const compiled = getPlatformDb()
      .updateTable("entity_active")
      .set({ current_version: nextVersion, retired_at: null })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", id)
      .compile()
    await runExecAsync(compiled)
    return
  }
  const compiled = getPlatformDb()
    .insertInto("entity_active")
    .values({
      tenant_id: tenantId,
      id,
      current_version: nextVersion,
      retired_at: null,
    })
    .compile()
  await runExecAsync(compiled)
}

/**
 * Save (insert or new version) an entity definition. The caller-supplied
 * `def` MUST already carry the new version's metadata (createdBy, reason,
 * createdAt — though createdAt may be left as the empty string and we'll
 * stamp it). `def.version` on input is ignored; we compute it.
 *
 * Atomicity: pointer update + version insert happen inside a single
 * SQLite transaction (better-sqlite3 `db.transaction(...)`).
 */
export async function saveEntityDefinition(args: {
  tenantId?: string
  def: EntityDefinition
  actor: string
  reason: string
  versionLabel?: string | null
  /** When true, reject if any row exists for this id (including retired). */
  createOnly?: boolean
}): Promise<SaveEntityResult> {
  const tenantId = asTenantId(args.tenantId ?? args.def.tenantId ?? DEFAULT_TENANT_ID)
  const def = normalizeEntityDefinition({ ...args.def, tenantId, version: 1 })
  const validation = validateEntityDefinition(def)
  if (!validation.ok) throw new EntityRegistryValidationError(validation)

  // Cross-reference validation: every id the entity points at must
  // actually resolve. Structural validators above can't do this — they
  // don't have access to the strategy / freeze-window stores.
  const xref = await validateEntityReferences(tenantId, def)
  if (!xref.ok) throw new EntityRegistryValidationError(xref)

  return await getPlatformStore().transactionAsync(async () => {
    const pointer = await selectEntityPointer(tenantId, args.def.id)

    if (args.createOnly && pointer) {
      throw new EntityRegistryConflictError(
        args.def.id,
        pointer.retired_at
          ? `entity id "${args.def.id}" already exists (retired). Choose a different id.`
          : `entity id "${args.def.id}" already exists`,
      )
    }

    const prev: EntityDefinition | null = pointer
      ? await readEntityVersionBody(tenantId, def.id, pointer.current_version)
      : null

    const nextVersion = (pointer?.current_version ?? 0) + 1
    const createdAt = def.createdAt || new Date().toISOString()

    const persisted: EntityDefinition = {
      ...def,
      tenantId,
      version: nextVersion,
      versionLabel: args.versionLabel ?? args.def.versionLabel ?? null,
      createdBy: args.actor,
      reason: args.reason,
      createdAt,
      retiredAt: null
    }

    const diff = diffEntityDefinitions(prev, persisted)

    await insertEntityVersion({
      tenant_id: tenantId,
      id: persisted.id,
      version: nextVersion,
      body_json: JSON.stringify(persisted),
      version_label: persisted.versionLabel,
      created_by: args.actor,
      created_at: createdAt,
      reason: reason(args.reason, prev === null),
      diff_json: JSON.stringify(diff),
    })

    await upsertEntityActivePointer(tenantId, persisted.id, nextVersion, pointer != null)

    return { tenantId, id: persisted.id, version: nextVersion, diff }
  })
}

function reason(input: string, isCreate: boolean): string {
  const trimmed = input.trim()
  if (trimmed.length > 0) return trimmed
  return isCreate ? "create" : "edit"
}

/**
 * Read the EntityDefinition body at a specific version. Returns null when
 * no such (tenant, id, version) tuple exists.
 */
export async function readEntityVersionBody(
  tenantId: string,
  id: string,
  version: number
): Promise<EntityDefinition | null> {
  const compiled = getPlatformDb()
    .selectFrom("entity_versions")
    .select("body_json")
    .where("tenant_id", "=", tenantId)
    .where("id", "=", id)
    .where("version", "=", version)
    .compile()
  const row = await runGetAsync<{ body_json: string }>(compiled)
  if (!row) return null
  return normalizeEntityDefinition(JSON.parse(row.body_json) as EntityDefinition)
}

/**
 * Get the current (or specified) version of an entity. Returns null if
 * the entity doesn't exist OR (without `version`) if it has been retired.
 * Pass `{ includeRetired: true }` to surface retired entities.
 */
export async function getEntityDefinition(
  tenantId: string,
  id: string,
  opts: { version?: number; includeRetired?: boolean } = {}
): Promise<EntityDefinition | null> {
  if (opts.version !== undefined) {
    return await readEntityVersionBody(tenantId, id, opts.version)
  }
  const pointer = await selectEntityPointer(tenantId, id)
  if (!pointer) return null
  if (pointer.retired_at && !opts.includeRetired) return null
  const def = await readEntityVersionBody(tenantId, id, pointer.current_version)
  if (!def) return null
  return { ...def, retiredAt: pointer.retired_at }
}

/**
 * List all entities in a tenant. Excludes retired by default. Returns
 * the *current* version body for each.
 */
export async function listEntityDefinitions(
  tenantId: string,
  opts: { includeRetired?: boolean } = {}
): Promise<EntityDefinition[]> {
  const compiled = getPlatformDb()
    .selectFrom("entity_active")
    .select(["id", "current_version", "retired_at"])
    .where("tenant_id", "=", tenantId)
    .orderBy("id")
    .compile()
  const rows = await runAllAsync<{ id: string; current_version: number; retired_at: string | null }>(compiled)

  const out: EntityDefinition[] = []
  for (const row of rows) {
    if (row.retired_at && !opts.includeRetired) continue
    const body = await readEntityVersionBody(tenantId, row.id, row.current_version)
    if (body) out.push({ ...body, retiredAt: row.retired_at })
  }
  return out
}

/**
 * List the version history for a single entity, newest first. Body JSON
 * is NOT included by default to keep the response small — use
 * `getEntityDefinition(tenant, id, { version })` to fetch a specific
 * one. `diff_json` IS returned so the UI can render "what changed in
 * each edit" without a second round trip.
 */
export interface EntityDefinitionHistoryEntry extends EntityDefinitionVersionRow {
  diff: ReturnType<typeof diffEntityDefinitions>
}

export async function listEntityDefinitionHistory(tenantId: string, id: string): Promise<EntityDefinitionHistoryEntry[]> {
  const compiled = getPlatformDb()
    .selectFrom("entity_versions")
    .select(["version", "version_label", "created_by", "created_at", "reason", "diff_json"])
    .where("tenant_id", "=", tenantId)
    .where("id", "=", id)
    .orderBy("version", "desc")
    .compile()
  const rows = await runAllAsync<{
    version: number
    version_label: string | null
    created_by: string
    created_at: string
    reason: string
    diff_json: string
  }>(compiled)

  return rows.map((r) => ({
    tenantId,
    id,
    version: r.version,
    versionLabel: r.version_label,
    createdBy: r.created_by,
    createdAt: r.created_at,
    reason: r.reason,
    diff: JSON.parse(r.diff_json)
  }))
}

/**
 * Mark an entity retired. Idempotent. Does NOT delete history; existing
 * pinned version references still resolve via `readEntityVersionBody`.
 */
export async function retireEntityDefinition(
  tenantId: string,
  id: string,
  actor: string
): Promise<{  retiredAt: string  } | null> {
  const pointer = await selectEntityPointer(tenantId, id)
  if (!pointer) return null
  if (pointer.retired_at) return { retiredAt: pointer.retired_at }

  const retiredAt = new Date().toISOString()
  return await getPlatformStore().transactionAsync(async () => {
    const setRetired = getPlatformDb()
      .updateTable("entity_active")
      .set({ retired_at: retiredAt })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", id)
      .compile()
    await runExecAsync(setRetired)

    // Record the retire as a new version so the diff history has it.
    const prev = await readEntityVersionBody(tenantId, id, pointer.current_version)
    if (prev) {
      const nextVersion = pointer.current_version + 1
      const retiredDef: EntityDefinition = {
        ...prev,
        version: nextVersion,
        versionLabel: null,
        createdBy: actor,
        reason: "retire",
        createdAt: retiredAt,
        retiredAt
      }
      const diff = diffEntityDefinitions(prev, retiredDef)
      await insertEntityVersion({
        tenant_id: tenantId,
        id,
        version: nextVersion,
        body_json: JSON.stringify(retiredDef),
        version_label: null,
        created_by: actor,
        created_at: retiredAt,
        reason: "retire",
        diff_json: JSON.stringify(diff),
      })
      const bumpVersion = getPlatformDb()
        .updateTable("entity_active")
        .set({ current_version: nextVersion })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", id)
        .compile()
      await runExecAsync(bumpVersion)
    }
    return { retiredAt }
  })
}

/**
 * Factory reset only — drops SQLite append-only triggers, wipes entity
 * rows, then restores triggers. Normal API paths must never call this.
 *
 * Trigger DDL is SQLite-adapter-specific (RAISE); row wipes go through Kysely.
 */
export async function wipeEntityRegistry(): Promise<void> {
  getDb().exec(`
    DROP TRIGGER IF EXISTS entity_versions_no_update;
    DROP TRIGGER IF EXISTS entity_versions_no_delete;
  `)
  await runExecAsync(getPlatformDb().deleteFrom("entity_versions").compile())
  await runExecAsync(getPlatformDb().deleteFrom("entity_active").compile())
  getDb().exec(`
    CREATE TRIGGER IF NOT EXISTS entity_versions_no_update
      BEFORE UPDATE ON entity_versions
      BEGIN SELECT RAISE(ABORT, 'entity_versions is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS entity_versions_no_delete
      BEFORE DELETE ON entity_versions
      BEGIN SELECT RAISE(ABORT, 'entity_versions is append-only'); END;
  `)
}

// ── SCD2 strategies ─────────────────────────────────────────────────

export interface SaveStrategyResult {
  tenantId: string
  id: string
  version: number
}

async function selectStrategyPointer(tenantId: string, id: string) {
  const compiled = getPlatformDb()
    .selectFrom("scd2_strategy_active")
    .select(["current_version", "retired_at"])
    .where("tenant_id", "=", tenantId)
    .where("id", "=", id)
    .compile()
  return await runGetAsync<{ current_version: number; retired_at: string | null }>(compiled)
}

async function insertStrategyVersion(row: {
  tenant_id: string
  id: string
  version: number
  body_json: string
  created_by: string
  created_at: string
  reason: string
}): Promise<void> {
  const compiled = getPlatformDb()
    .insertInto("scd2_strategy_versions")
    .values(row)
    .compile()
  await runExecAsync(compiled)
}

async function upsertStrategyActivePointer(
  tenantId: string,
  id: string,
  nextVersion: number,
  hadPointer: boolean,
): Promise<void> {
  if (hadPointer) {
    const compiled = getPlatformDb()
      .updateTable("scd2_strategy_active")
      .set({ current_version: nextVersion, retired_at: null })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", id)
      .compile()
    await runExecAsync(compiled)
    return
  }
  const compiled = getPlatformDb()
    .insertInto("scd2_strategy_active")
    .values({
      tenant_id: tenantId,
      id,
      current_version: nextVersion,
      retired_at: null,
    })
    .compile()
  await runExecAsync(compiled)
}

/**
 * Save a new SCD2 strategy version. Same append-only semantics as
 * entity definitions. Returns the new version number.
 */
export async function saveScd2Strategy(args: {
  tenantId?: string
  strategy: Scd2Strategy
  actor: string
  reason: string
}): Promise<SaveStrategyResult> {
  const tenantId = args.tenantId ?? DEFAULT_TENANT_ID
  const validation = validateScd2Strategy(args.strategy)
  if (!validation.ok) throw new EntityRegistryValidationError(validation)

  const normalized = normalizeScd2Strategy(args.strategy)

  return await getPlatformStore().transactionAsync(async () => {
    const pointer = await selectStrategyPointer(tenantId, normalized.id)

    const nextVersion = (pointer?.current_version ?? 0) + 1
    const createdAt = normalized.createdAt || new Date().toISOString()
    const persisted: Scd2Strategy = {
      ...normalized,
      version: nextVersion,
      createdBy: args.actor,
      createdAt
    }

    await insertStrategyVersion({
      tenant_id: tenantId,
      id: persisted.id,
      version: nextVersion,
      body_json: JSON.stringify(persisted),
      created_by: args.actor,
      created_at: createdAt,
      reason: args.reason || (pointer ? "edit" : "create"),
    })

    await upsertStrategyActivePointer(tenantId, persisted.id, nextVersion, pointer != null)

    return { tenantId, id: persisted.id, version: nextVersion }
  })
}

/**
 * Resolve a strategy reference for use by the projector. Order:
 *   1. `version` is a number → exact tenant version row
 *   2. `version` is "latest" or omitted → current pointer's version row
 *   3. tenant has no such strategy → fall back to bundled (if id matches)
 *
 * Returns null when nothing resolves. Retired strategies are still
 * resolvable (historical recipes must remain runnable).
 */
export async function resolveScd2Strategy(
  tenantId: string,
  id: string,
  version?: number | "latest"
): Promise<Scd2Strategy | null> {
  if (typeof version === "number") {
    const row = await readStrategyVersionBody(tenantId, id, version)
    if (row) return row
    for (const fallbackTenant of strategyResolutionTenants(tenantId).slice(1)) {
      const def = await readStrategyVersionBody(fallbackTenant, id, version)
      if (def) return def
    }
    return null
  }

  for (const t of strategyResolutionTenants(tenantId)) {
    const pointer = await selectStrategyPointer(t, id)
    if (pointer) {
      const row = await readStrategyVersionBody(t, id, pointer.current_version)
      if (row) return row
    }
  }
  return null
}

async function readStrategyVersionBody(tenantId: string, id: string, version: number): Promise<Scd2Strategy | null> {
  const compiled = getPlatformDb()
    .selectFrom("scd2_strategy_versions")
    .select("body_json")
    .where("tenant_id", "=", tenantId)
    .where("id", "=", id)
    .where("version", "=", version)
    .compile()
  const row = await runGetAsync<{ body_json: string }>(compiled)
  if (!row) return null
  return parseStoredStrategy(row.body_json)
}

/**
 * List strategies available to a tenant. Includes both tenant-private
 * strategies and the inherited default-tenant (bundled) strategies that
 * the tenant hasn't shadowed.
 */
export interface Scd2StrategyHistoryEntry {
  tenantId: string
  id: string
  version: number
  versionLabel: string | null
  createdBy: string
  createdAt: string
  reason: string
}

async function readStrategyHistoryRows(tenantId: string, id: string): Promise<Scd2StrategyHistoryEntry[]> {
  const compiled = getPlatformDb()
    .selectFrom("scd2_strategy_versions")
    .select(["version", "body_json", "created_by", "created_at", "reason"])
    .where("tenant_id", "=", tenantId)
    .where("id", "=", id)
    .orderBy("version", "desc")
    .compile()
  const rows = await runAllAsync<{
    version: number
    body_json: string
    created_by: string
    created_at: string
    reason: string
  }>(compiled)

  return rows.map((r) => {
    const body = JSON.parse(r.body_json) as Scd2Strategy
    return {
      tenantId,
      id,
      version: r.version,
      versionLabel: body.versionLabel ?? null,
      createdBy: r.created_by,
      createdAt: r.created_at,
      reason: r.reason
    }
  })
}

/**
 * Append-only version history for a strategy. Falls back to the default
 * tenant when the requesting tenant has no rows, then to the bundled
 * constant when the id is a shipped default with no DB rows yet.
 */
export async function listScd2StrategyHistory(tenantId: string, id: string): Promise<Scd2StrategyHistoryEntry[]> {
  const tenantRows = await readStrategyHistoryRows(tenantId, id)
  if (tenantRows.length > 0) return tenantRows

  for (const fallbackTenant of strategyHistoryTenants(tenantId).slice(1)) {
    const defaultRows = await readStrategyHistoryRows(fallbackTenant, id)
    if (defaultRows.length > 0) return defaultRows
  }

  return []
}

export async function listAvailableStrategies(tenantId: string): Promise<Scd2Strategy[]> {
  const tenantStrategies = await readTenantStrategies(tenantId)
  if (!mergesBundledStrategies(tenantId)) return tenantStrategies
  const seen = new Set(tenantStrategies.map((s) => s.id))
  const defaults = (await readTenantStrategies(DEFAULT_TENANT_ID)).filter((s) => !seen.has(s.id))
  return [...tenantStrategies, ...defaults]
}

async function readTenantStrategies(
  tenantId: string,
  opts: { includeRetired?: boolean } = {},
): Promise<Scd2Strategy[]> {
  let query = getPlatformDb()
    .selectFrom("scd2_strategy_active as s")
    .innerJoin("scd2_strategy_versions as v", (join) =>
      join
        .onRef("v.tenant_id", "=", "s.tenant_id")
        .onRef("v.id", "=", "s.id")
        .onRef("v.version", "=", "s.current_version")
    )
    .select(["s.id", "s.current_version", "s.retired_at", "v.body_json"])
    .where("s.tenant_id", "=", tenantId)
    .orderBy("s.id")

  if (!opts.includeRetired) {
    query = query.where("s.retired_at", "is", null)
  }

  const rows = await runAllAsync<{ id: string; current_version: number; retired_at: string | null; body_json: string }>(
    query.compile(),
  )
  return rows.map((r) => parseStoredStrategy(r.body_json))
}

export async function countActiveEntitiesUsingStrategy(tenantId: string, strategyId: string): Promise<number> {
  return (await listEntityDefinitions(tenantId)).filter((def) => def.scd2.strategyId === strategyId).length
}

/**
 * Retire a tenant-owned strategy. Shipped bundled defaults that only exist
 * as inherited constants cannot be retired — fork a custom copy instead.
 * Historical version rows remain for pinned entity references.
 */
export async function retireScd2Strategy(
  tenantId: string,
  id: string,
): Promise<{  retiredAt: string  } | null> {
  const pointer = await selectStrategyPointer(tenantId, id)
  if (!pointer) return null
  if (pointer.retired_at) return { retiredAt: pointer.retired_at }

  const inUse = await countActiveEntitiesUsingStrategy(tenantId, id)
  if (inUse > 0) {
    throw new Error(
      `Strategy "${id}" is referenced by ${inUse} active entity definition(s). Retire or reassign them first.`,
    )
  }

  const retiredAt = new Date().toISOString()
  const compiled = getPlatformDb()
    .updateTable("scd2_strategy_active")
    .set({ retired_at: retiredAt })
    .where("tenant_id", "=", tenantId)
    .where("id", "=", id)
    .compile()
  await runExecAsync(compiled)
  return { retiredAt }
}
