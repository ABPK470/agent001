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
import { listFreezeWindowsForTenant } from "./freeze-windows.js"

const DEFAULT_TENANT_ID = "_default"

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
    flowId: typeof r.flowId === "string" && r.flowId.trim() !== "" ? r.flowId : r.id,
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
//                                            mirrors freeze_windows DB)
function validateEntityReferences(tenantId: string, def: EntityDefinition): ValidationResult {
  const errors: ValidationResult["errors"] = []
  const warnings: ValidationResult["warnings"] = []

  // strategy resolution
  const strategy = resolveScd2Strategy(tenantId, def.scd2.strategyId, def.scd2.strategyVersion)
  if (!strategy) {
    errors.push({
      path: "scd2.strategyId",
      code: "scd2_strategy_unknown",
      message: `SCD2 strategy "${def.scd2.strategyId}" v${def.scd2.strategyVersion} does not resolve for tenant "${tenantId}". Pick one from GET /api/entity-registry/strategies, or create a custom strategy first.`
    })
  }

  // freeze windows: every referenced id must be in the in-process
  // registry (which mirrors the freeze_windows DB table for _default).
  if (def.policies.freezeWindowIds.length > 0) {
    const reg = listFreezeWindowIdsForGate()
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
function listFreezeWindowIdsForGate(): Set<string> {
  return new Set(listFreezeWindowsForTenant(DEFAULT_TENANT_ID).map((w) => w.id))
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

/**
 * Save (insert or new version) an entity definition. The caller-supplied
 * `def` MUST already carry the new version's metadata (createdBy, reason,
 * createdAt — though createdAt may be left as the empty string and we'll
 * stamp it). `def.version` on input is ignored; we compute it.
 *
 * Atomicity: pointer update + version insert happen inside a single
 * SQLite transaction (better-sqlite3 `db.transaction(...)`).
 */
export function saveEntityDefinition(args: {
  tenantId?: string
  def: EntityDefinition
  actor: string
  reason: string
  versionLabel?: string | null
  /** When true, reject if any row exists for this id (including retired). */
  createOnly?: boolean
}): SaveEntityResult {
  const tenantId = args.tenantId ?? args.def.tenantId ?? DEFAULT_TENANT_ID
  const def = normalizeEntityDefinition({ ...args.def, tenantId, version: 1 })
  const validation = validateEntityDefinition(def)
  if (!validation.ok) throw new EntityRegistryValidationError(validation)

  // Cross-reference validation: every id the entity points at must
  // actually resolve. Structural validators above can't do this — they
  // don't have access to the strategy / freeze-window stores.
  const xref = validateEntityReferences(tenantId, def)
  if (!xref.ok) throw new EntityRegistryValidationError(xref)

  const db = getDb()

  return db.transaction(() => {
    const pointer = db
      .prepare(`SELECT current_version, retired_at FROM entity_active WHERE tenant_id = ? AND id = ?`)
      .get(tenantId, args.def.id) as { current_version: number; retired_at: string | null } | undefined

    if (args.createOnly && pointer) {
      throw new EntityRegistryConflictError(
        args.def.id,
        pointer.retired_at
          ? `entity id "${args.def.id}" already exists (retired). Choose a different id.`
          : `entity id "${args.def.id}" already exists`,
      )
    }

    const prev: EntityDefinition | null = pointer
      ? readEntityVersionBody(tenantId, def.id, pointer.current_version)
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

    db.prepare(
      `INSERT INTO entity_versions
         (tenant_id, id, version, body_json, version_label, created_by, created_at, reason, diff_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      tenantId,
      persisted.id,
      nextVersion,
      JSON.stringify(persisted),
      persisted.versionLabel,
      args.actor,
      createdAt,
      reason(args.reason, prev === null),
      JSON.stringify(diff)
    )

    if (pointer) {
      db.prepare(
        `UPDATE entity_active SET current_version = ?, retired_at = NULL WHERE tenant_id = ? AND id = ?`
      ).run(nextVersion, tenantId, persisted.id)
    } else {
      db.prepare(
        `INSERT INTO entity_active (tenant_id, id, current_version, retired_at) VALUES (?, ?, ?, NULL)`
      ).run(tenantId, persisted.id, nextVersion)
    }

    return { tenantId, id: persisted.id, version: nextVersion, diff }
  })()
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
export function readEntityVersionBody(
  tenantId: string,
  id: string,
  version: number
): EntityDefinition | null {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT body_json FROM entity_versions
       WHERE tenant_id = ? AND id = ? AND version = ?`
    )
    .get(tenantId, id, version) as { body_json: string } | undefined
  if (!row) return null
  return normalizeEntityDefinition(JSON.parse(row.body_json) as EntityDefinition)
}

/**
 * Get the current (or specified) version of an entity. Returns null if
 * the entity doesn't exist OR (without `version`) if it has been retired.
 * Pass `{ includeRetired: true }` to surface retired entities.
 */
export function getEntityDefinition(
  tenantId: string,
  id: string,
  opts: { version?: number; includeRetired?: boolean } = {}
): EntityDefinition | null {
  const db = getDb()
  if (opts.version !== undefined) {
    return readEntityVersionBody(tenantId, id, opts.version)
  }
  const pointer = db
    .prepare(`SELECT current_version, retired_at FROM entity_active WHERE tenant_id = ? AND id = ?`)
    .get(tenantId, id) as { current_version: number; retired_at: string | null } | undefined
  if (!pointer) return null
  if (pointer.retired_at && !opts.includeRetired) return null
  const def = readEntityVersionBody(tenantId, id, pointer.current_version)
  if (!def) return null
  return { ...def, retiredAt: pointer.retired_at }
}

/**
 * List all entities in a tenant. Excludes retired by default. Returns
 * the *current* version body for each.
 */
export function listEntityDefinitions(
  tenantId: string,
  opts: { includeRetired?: boolean } = {}
): EntityDefinition[] {
  const db = getDb()
  const rows = db
    .prepare(`SELECT id, current_version, retired_at FROM entity_active WHERE tenant_id = ? ORDER BY id`)
    .all(tenantId) as { id: string; current_version: number; retired_at: string | null }[]

  const out: EntityDefinition[] = []
  for (const row of rows) {
    if (row.retired_at && !opts.includeRetired) continue
    const body = readEntityVersionBody(tenantId, row.id, row.current_version)
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

export function listEntityDefinitionHistory(tenantId: string, id: string): EntityDefinitionHistoryEntry[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT version, version_label, created_by, created_at, reason, diff_json
       FROM entity_versions
       WHERE tenant_id = ? AND id = ?
       ORDER BY version DESC`
    )
    .all(tenantId, id) as {
    version: number
    version_label: string | null
    created_by: string
    created_at: string
    reason: string
    diff_json: string
  }[]

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
export function retireEntityDefinition(
  tenantId: string,
  id: string,
  actor: string
): { retiredAt: string } | null {
  const db = getDb()
  const pointer = db
    .prepare(`SELECT current_version, retired_at FROM entity_active WHERE tenant_id = ? AND id = ?`)
    .get(tenantId, id) as { current_version: number; retired_at: string | null } | undefined
  if (!pointer) return null
  if (pointer.retired_at) return { retiredAt: pointer.retired_at }

  const retiredAt = new Date().toISOString()
  return db.transaction(() => {
    db.prepare(`UPDATE entity_active SET retired_at = ? WHERE tenant_id = ? AND id = ?`).run(
      retiredAt,
      tenantId,
      id
    )
    // Record the retire as a new version so the diff history has it.
    const prev = readEntityVersionBody(tenantId, id, pointer.current_version)
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
      db.prepare(
        `INSERT INTO entity_versions
           (tenant_id, id, version, body_json, version_label, created_by, created_at, reason, diff_json)
         VALUES (?, ?, ?, ?, NULL, ?, ?, 'retire', ?)`
      ).run(tenantId, id, nextVersion, JSON.stringify(retiredDef), actor, retiredAt, JSON.stringify(diff))
      db.prepare(`UPDATE entity_active SET current_version = ? WHERE tenant_id = ? AND id = ?`).run(
        nextVersion,
        tenantId,
        id
      )
    }
    return { retiredAt }
  })()
}

/**
 * Factory reset only — drops append-only triggers, wipes all entity rows,
 * then restores triggers. Normal API paths must never call this.
 */
export function wipeEntityRegistry(): void {
  const db = getDb()
  db.exec(`
    DROP TRIGGER IF EXISTS entity_versions_no_update;
    DROP TRIGGER IF EXISTS entity_versions_no_delete;
  `)
  db.exec(`DELETE FROM entity_versions`)
  db.exec(`DELETE FROM entity_active`)
  db.exec(`
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

/**
 * Save a new SCD2 strategy version. Same append-only semantics as
 * entity definitions. Returns the new version number.
 */
export function saveScd2Strategy(args: {
  tenantId?: string
  strategy: Scd2Strategy
  actor: string
  reason: string
}): SaveStrategyResult {
  const tenantId = args.tenantId ?? DEFAULT_TENANT_ID
  const validation = validateScd2Strategy(args.strategy)
  if (!validation.ok) throw new EntityRegistryValidationError(validation)

  const normalized = normalizeScd2Strategy(args.strategy)

  const db = getDb()
  return db.transaction(() => {
    const pointer = db
      .prepare(`SELECT current_version FROM scd2_strategy_active WHERE tenant_id = ? AND id = ?`)
      .get(tenantId, normalized.id) as { current_version: number } | undefined

    const nextVersion = (pointer?.current_version ?? 0) + 1
    const createdAt = normalized.createdAt || new Date().toISOString()
    const persisted: Scd2Strategy = {
      ...normalized,
      version: nextVersion,
      createdBy: args.actor,
      createdAt
    }

    db.prepare(
      `INSERT INTO scd2_strategy_versions
         (tenant_id, id, version, body_json, created_by, created_at, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      tenantId,
      persisted.id,
      nextVersion,
      JSON.stringify(persisted),
      args.actor,
      createdAt,
      args.reason || (pointer ? "edit" : "create")
    )

    if (pointer) {
      db.prepare(
        `UPDATE scd2_strategy_active SET current_version = ?, retired_at = NULL WHERE tenant_id = ? AND id = ?`
      ).run(nextVersion, tenantId, persisted.id)
    } else {
      db.prepare(
        `INSERT INTO scd2_strategy_active (tenant_id, id, current_version, retired_at) VALUES (?, ?, ?, NULL)`
      ).run(tenantId, persisted.id, nextVersion)
    }

    return { tenantId, id: persisted.id, version: nextVersion }
  })()
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
export function resolveScd2Strategy(
  tenantId: string,
  id: string,
  version?: number | "latest"
): Scd2Strategy | null {
  const db = getDb()

  if (typeof version === "number") {
    const row = db
      .prepare(
        `SELECT body_json FROM scd2_strategy_versions
         WHERE tenant_id = ? AND id = ? AND version = ?`
      )
      .get(tenantId, id, version) as { body_json: string } | undefined
    if (row) return parseStoredStrategy(row.body_json)
    if (tenantId !== DEFAULT_TENANT_ID) {
      const def = db
        .prepare(
          `SELECT body_json FROM scd2_strategy_versions
           WHERE tenant_id = ? AND id = ? AND version = ?`
        )
        .get(DEFAULT_TENANT_ID, id, version) as { body_json: string } | undefined
      if (def) return parseStoredStrategy(def.body_json)
    }
    return null
  }

  // "latest" or undefined → current pointer for tenant, then default tenant,
  // then bundled.
  for (const t of tenantId === DEFAULT_TENANT_ID ? [DEFAULT_TENANT_ID] : [tenantId, DEFAULT_TENANT_ID]) {
    const pointer = db
      .prepare(`SELECT current_version FROM scd2_strategy_active WHERE tenant_id = ? AND id = ?`)
      .get(t, id) as { current_version: number } | undefined
    if (pointer) {
      const row = db
        .prepare(
          `SELECT body_json FROM scd2_strategy_versions WHERE tenant_id = ? AND id = ? AND version = ?`
        )
        .get(t, id, pointer.current_version) as { body_json: string } | undefined
      if (row) return parseStoredStrategy(row.body_json)
    }
  }
  return null
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

function readStrategyHistoryRows(
  db: ReturnType<typeof getDb>,
  tenantId: string,
  id: string
): Scd2StrategyHistoryEntry[] {
  const rows = db
    .prepare(
      `SELECT version, body_json, created_by, created_at, reason
       FROM scd2_strategy_versions
       WHERE tenant_id = ? AND id = ?
       ORDER BY version DESC`
    )
    .all(tenantId, id) as {
    version: number
    body_json: string
    created_by: string
    created_at: string
    reason: string
  }[]

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
export function listScd2StrategyHistory(tenantId: string, id: string): Scd2StrategyHistoryEntry[] {
  const db = getDb()
  const tenantRows = readStrategyHistoryRows(db, tenantId, id)
  if (tenantRows.length > 0) return tenantRows

  if (tenantId !== DEFAULT_TENANT_ID) {
    const defaultRows = readStrategyHistoryRows(db, DEFAULT_TENANT_ID, id)
    if (defaultRows.length > 0) return defaultRows
  }

  return []
}

export function listAvailableStrategies(tenantId: string): Scd2Strategy[] {
  const db = getDb()
  const tenantStrategies = readTenantStrategies(db, tenantId)
  const seen = new Set(tenantStrategies.map((s) => s.id))
  if (tenantId === DEFAULT_TENANT_ID) return tenantStrategies
  const defaults = readTenantStrategies(db, DEFAULT_TENANT_ID).filter((s) => !seen.has(s.id))
  return [...tenantStrategies, ...defaults]
}

function readTenantStrategies(
  db: ReturnType<typeof getDb>,
  tenantId: string,
  opts: { includeRetired?: boolean } = {},
): Scd2Strategy[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.current_version, s.retired_at, v.body_json
       FROM scd2_strategy_active s
       JOIN scd2_strategy_versions v
         ON v.tenant_id = s.tenant_id AND v.id = s.id AND v.version = s.current_version
       WHERE s.tenant_id = ?
       ${opts.includeRetired ? "" : "AND s.retired_at IS NULL"}
       ORDER BY s.id`
    )
    .all(tenantId) as { id: string; current_version: number; retired_at: string | null; body_json: string }[]
  return rows.map((r) => parseStoredStrategy(r.body_json))
}

export function countActiveEntitiesUsingStrategy(tenantId: string, strategyId: string): number {
  return listEntityDefinitions(tenantId).filter((def) => def.scd2.strategyId === strategyId).length
}

/**
 * Retire a tenant-owned strategy. Shipped bundled defaults that only exist
 * as inherited constants cannot be retired — fork a custom copy instead.
 * Historical version rows remain for pinned entity references.
 */
export function retireScd2Strategy(
  tenantId: string,
  id: string,
): { retiredAt: string } | null {
  const db = getDb()
  const pointer = db
    .prepare(`SELECT current_version, retired_at FROM scd2_strategy_active WHERE tenant_id = ? AND id = ?`)
    .get(tenantId, id) as { current_version: number; retired_at: string | null } | undefined
  if (!pointer) return null
  if (pointer.retired_at) return { retiredAt: pointer.retired_at }

  const inUse = countActiveEntitiesUsingStrategy(tenantId, id)
  if (inUse > 0) {
    throw new Error(
      `Strategy "${id}" is referenced by ${inUse} active entity definition(s). Retire or reassign them first.`,
    )
  }

  const retiredAt = new Date().toISOString()
  db.prepare(`UPDATE scd2_strategy_active SET retired_at = ? WHERE tenant_id = ? AND id = ?`).run(
    retiredAt,
    tenantId,
    id,
  )
  return { retiredAt }
}
