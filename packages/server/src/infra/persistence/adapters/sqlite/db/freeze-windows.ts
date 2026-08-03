/**
 * Freeze-window persistence (tenant-scoped).
 *
 * The agent reads freeze-window definitions through a host-wired reader.
 * This module owns the durable backing store and exposes a read helper the
 * server passes into `configureAgent({ sync: { governance: { freezeWindowsReader } } })`.
 *
 * Schema is created in `migrations/0001_baseline.ts`; this file only
 * holds the CRUD helpers and the registry-rehydrate routine.
 */

import { DEFAULT_TENANT_ID, installFreezeWindowRegistry, type FreezeWindowDefinition } from "@mia/sync"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runAll, runChanges, runGet } from "../../../schema/execute.js"
import { platformNow } from "../../../schema/sql-time.js"
import { upsertRow } from "../../../schema/upsert.js"
import { refreshesGlobalRegistryOnMutation } from "./tenant-inheritance.js"

// ── Public type (matches shared-types `FreezeWindow`) ───────────

export interface FreezeWindowRecord {
  tenantId: string
  id: string
  displayName: string
  description: string
  startsAt: string
  endsAt: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

// ── Validation ──────────────────────────────────────────────────

const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/

export class FreezeWindowValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FreezeWindowValidationError"
  }
}

function validate(
  input: Pick<FreezeWindowRecord, "id" | "displayName" | "description" | "startsAt" | "endsAt">
): void {
  if (!ID_RE.test(input.id)) throw new FreezeWindowValidationError(`id: must match ${ID_RE}`)
  if (!input.displayName.trim()) throw new FreezeWindowValidationError("displayName is required")
  if (typeof input.description !== "string")
    throw new FreezeWindowValidationError("description must be a string")
  const startMs = Date.parse(input.startsAt)
  const endMs = Date.parse(input.endsAt)
  if (Number.isNaN(startMs)) throw new FreezeWindowValidationError("startsAt: not a valid ISO-8601 timestamp")
  if (Number.isNaN(endMs)) throw new FreezeWindowValidationError("endsAt: not a valid ISO-8601 timestamp")
  if (endMs <= startMs) throw new FreezeWindowValidationError("endsAt must be strictly after startsAt")
}

// ── CRUD ────────────────────────────────────────────────────────

interface Row {
  tenant_id: string
  id: string
  display_name: string
  description: string
  starts_at: string
  ends_at: string
  created_by: string
  created_at: string
  updated_at: string
}

const rowToRecord = (r: Row): FreezeWindowRecord => ({
  tenantId: r.tenant_id,
  id: r.id,
  displayName: r.display_name,
  description: r.description,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

export function listFreezeWindowsForTenant(tenantId: string): FreezeWindowRecord[] {
  const compiled = getPlatformDb()
    .selectFrom("freeze_window_configs")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .orderBy("starts_at", "asc")
    .orderBy("id", "asc")
    .compile()
  return runAll<Row>(compiled).map(rowToRecord)
}

export function getFreezeWindow(tenantId: string, id: string): FreezeWindowRecord | null {
  const compiled = getPlatformDb()
    .selectFrom("freeze_window_configs")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .where("id", "=", id)
    .compile()
  const r = runGet<Row>(compiled)
  return r ? rowToRecord(r) : null
}

export interface UpsertFreezeWindowArgs {
  tenantId: string
  id: string
  displayName: string
  description: string
  startsAt: string
  endsAt: string
  actor: string
}

export function upsertFreezeWindow(args: UpsertFreezeWindowArgs): FreezeWindowRecord {
  validate(args)
  const now = platformNow()
  upsertRow({
    table: "freeze_window_configs",
    keys: { tenant_id: args.tenantId, id: args.id },
    insert: {
      tenant_id: args.tenantId,
      id: args.id,
      display_name: args.displayName,
      description: args.description,
      starts_at: args.startsAt,
      ends_at: args.endsAt,
      created_by: args.actor,
      created_at: now,
      updated_at: now,
    },
    update: {
      display_name: args.displayName,
      description: args.description,
      starts_at: args.startsAt,
      ends_at: args.endsAt,
      updated_at: now,
    },
  })
  const fresh = getFreezeWindow(args.tenantId, args.id)
  if (!fresh) throw new Error(`freeze_window not persisted: ${args.id}`)
  if (refreshesGlobalRegistryOnMutation(args.tenantId)) refreshFreezeWindowRegistry()
  return fresh
}

export function deleteFreezeWindow(tenantId: string, id: string): boolean {
  const compiled = getPlatformDb()
    .deleteFrom("freeze_window_configs")
    .where("tenant_id", "=", tenantId)
    .where("id", "=", id)
    .compile()
  const changes = runChanges(compiled)
  if (changes > 0 && refreshesGlobalRegistryOnMutation(tenantId)) refreshFreezeWindowRegistry()
  return changes > 0
}

// ── Host reader bridge ──────────────────────────────────────────

/**
 * Read persisted freeze windows in the agent's `FreezeWindowDefinition`
 * shape. The server passes this into the host so sync execution evaluates
 * against live persisted data without any agent-side singleton registry.
 *
 * Today the evaluator is tenant-agnostic (one global registry); we
 * publish the `_default` tenant set since the single-tenant deployment
 * is the only shipping shape. Future multi-tenant work will swap this
 * for a tenant-keyed registry.
 */
export function listFreezeWindowDefinitionsForTenant(tenantId = DEFAULT_TENANT_ID): FreezeWindowDefinition[] {
  const recs = listFreezeWindowsForTenant(tenantId)
  return recs.map((r) => ({
    id: r.id,
    displayName: r.displayName,
    description: r.description,
    startsAt: r.startsAt,
    endsAt: r.endsAt
  }))
}

export function refreshFreezeWindowRegistry(tenantId = DEFAULT_TENANT_ID): FreezeWindowDefinition[] {
  const defs = listFreezeWindowDefinitionsForTenant(tenantId)
  if (refreshesGlobalRegistryOnMutation(tenantId)) installFreezeWindowRegistry(defs)
  return defs
}
