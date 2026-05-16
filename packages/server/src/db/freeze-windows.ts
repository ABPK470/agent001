/**
 * Freeze-window persistence (tenant-scoped).
 *
 * The agent owns the in-process evaluator (`evaluateFreezeWindows`) and
 * the registry interface (`installFreezeWindowRegistry`). This module
 * owns the durable backing store and the boot-time bridge that pushes
 * the persisted set into that registry.
 *
 * Schema is created in `connection.ts::_migrate`; this file only
 * holds the CRUD helpers and the registry-rehydrate routine.
 */

import {
    DEFAULT_TENANT_ID,
    installFreezeWindowRegistry,
    type FreezeWindowDefinition,
} from "@mia/agent"
import { getDb } from "./connection.js"

// ── Public type (matches shared-types `FreezeWindow`) ───────────

export interface FreezeWindowRecord {
  tenantId:    string
  id:          string
  displayName: string
  description: string
  startsAt:    string
  endsAt:      string
  createdBy:   string
  createdAt:   string
  updatedAt:   string
}

// ── Validation ──────────────────────────────────────────────────

const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/

export class FreezeWindowValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FreezeWindowValidationError"
  }
}

function validate(input: Pick<FreezeWindowRecord, "id" | "displayName" | "description" | "startsAt" | "endsAt">): void {
  if (!ID_RE.test(input.id))           throw new FreezeWindowValidationError(`id: must match ${ID_RE}`)
  if (!input.displayName.trim())       throw new FreezeWindowValidationError("displayName is required")
  if (typeof input.description !== "string") throw new FreezeWindowValidationError("description must be a string")
  const startMs = Date.parse(input.startsAt)
  const endMs   = Date.parse(input.endsAt)
  if (Number.isNaN(startMs))           throw new FreezeWindowValidationError("startsAt: not a valid ISO-8601 timestamp")
  if (Number.isNaN(endMs))             throw new FreezeWindowValidationError("endsAt: not a valid ISO-8601 timestamp")
  if (endMs <= startMs)                throw new FreezeWindowValidationError("endsAt must be strictly after startsAt")
}

// ── CRUD ────────────────────────────────────────────────────────

interface Row {
  tenant_id:    string
  id:           string
  display_name: string
  description:  string
  starts_at:    string
  ends_at:      string
  created_by:   string
  created_at:   string
  updated_at:   string
}

const rowToRecord = (r: Row): FreezeWindowRecord => ({
  tenantId:    r.tenant_id,
  id:          r.id,
  displayName: r.display_name,
  description: r.description,
  startsAt:    r.starts_at,
  endsAt:      r.ends_at,
  createdBy:   r.created_by,
  createdAt:   r.created_at,
  updatedAt:   r.updated_at,
})

export function listFreezeWindowsForTenant(tenantId: string): FreezeWindowRecord[] {
  const rows = getDb().prepare(
    `SELECT * FROM freeze_windows WHERE tenant_id = ? ORDER BY starts_at ASC, id ASC`,
  ).all(tenantId) as Row[]
  return rows.map(rowToRecord)
}

export function getFreezeWindow(tenantId: string, id: string): FreezeWindowRecord | null {
  const r = getDb().prepare(
    `SELECT * FROM freeze_windows WHERE tenant_id = ? AND id = ?`,
  ).get(tenantId, id) as Row | undefined
  return r ? rowToRecord(r) : null
}

export interface UpsertFreezeWindowArgs {
  tenantId:    string
  id:          string
  displayName: string
  description: string
  startsAt:    string
  endsAt:      string
  actor:       string
}

export function upsertFreezeWindow(args: UpsertFreezeWindowArgs): FreezeWindowRecord {
  validate(args)
  const db = getDb()
  db.prepare(`
    INSERT INTO freeze_windows
      (tenant_id, id, display_name, description, starts_at, ends_at, created_by, created_at, updated_at)
    VALUES
      (@tenantId, @id, @displayName, @description, @startsAt, @endsAt, @actor,
       datetime('now'), datetime('now'))
    ON CONFLICT(tenant_id, id) DO UPDATE SET
      display_name = excluded.display_name,
      description  = excluded.description,
      starts_at    = excluded.starts_at,
      ends_at      = excluded.ends_at,
      updated_at   = datetime('now')
  `).run({
    tenantId:    args.tenantId,
    id:          args.id,
    displayName: args.displayName,
    description: args.description,
    startsAt:    args.startsAt,
    endsAt:      args.endsAt,
    actor:       args.actor,
  })
  const fresh = getFreezeWindow(args.tenantId, args.id)
  if (!fresh) throw new Error(`freeze_window not persisted: ${args.id}`)
  // Mirror into the in-process evaluator so subsequent sync gates see it.
  refreshFreezeWindowRegistry()
  return fresh
}

export function deleteFreezeWindow(tenantId: string, id: string): boolean {
  const info = getDb().prepare(
    `DELETE FROM freeze_windows WHERE tenant_id = ? AND id = ?`,
  ).run(tenantId, id)
  if (info.changes > 0) refreshFreezeWindowRegistry()
  return info.changes > 0
}

// ── Registry bridge ─────────────────────────────────────────────

/**
 * Push every persisted freeze window into the agent's in-process
 * registry. Called once at server boot (after `_migrate`) and again
 * on every upsert/delete so the evaluator stays consistent.
 *
 * Today the evaluator is tenant-agnostic (one global registry); we
 * publish the `_default` tenant set since the single-tenant deployment
 * is the only shipping shape. Future multi-tenant work will swap this
 * for a tenant-keyed registry.
 */
export function refreshFreezeWindowRegistry(): void {
  const recs = listFreezeWindowsForTenant(DEFAULT_TENANT_ID)
  const defs: FreezeWindowDefinition[] = recs.map((r) => ({
    id:          r.id,
    displayName: r.displayName,
    description: r.description,
    startsAt:    r.startsAt,
    endsAt:      r.endsAt,
  }))
  installFreezeWindowRegistry(defs)
}
