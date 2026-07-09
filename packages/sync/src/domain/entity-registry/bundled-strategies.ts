/**
 * Bundled SCD2 strategies that ship in the box.
 *
 * These are the seed data installed on first run of a fresh tenant. Tenants
 * may pin to a specific version (immutable) or track `"latest"` (auto-bump
 * as we ship new bundled versions); they may also fork a bundled strategy
 * into a tenant-private custom strategy via the UI.
 *
 * Each bundled strategy is reproducible: changing the constants here AND
 * bumping the version number is the supported way to evolve them. Existing
 * pinned references continue to resolve against the prior version (storage
 * layer keeps every version row immutable).
 */

import type { Scd2Strategy } from "./types.js"

const BUNDLED_VERSION = 1
const BUNDLED_CREATED_AT = "1970-01-01T00:00:00.000Z" as const
const BUNDLED_CREATED_BY = "system" as const

/**
 * Mymi/ABI convention: full SCD2 + lock + sync/deploy date columns. Mirrors
 * the column handling baked into the legacy `core.uspSyncObjectTran` sproc
 * (see /memories/repo/abi-sync-ground-truth.md lines 46-55).
 */
const MYMI_SCD2: Scd2Strategy = {
  id: "mymi-scd2",
  displayName: "Mymi / ABI SCD2",
  description:
    "Full Mymi convention: validFrom/validTo validity range, isLocked / syncDate / deployDate columns excluded from diff, identity preserved via SET IDENTITY_INSERT ON. Use for entities sourced from the standard ABI metadata schema.",
  validFromCol: "validFrom",
  validToCol: "validTo",
  isLockedCol: "isLocked",
  syncDateCol: "sync-date",
  deployDateCol: "deploy-date",
  identityHandling: "setIdentityInsertOn",
  excludedFromDiffCols: ["validFrom", "validTo", "isLocked", "sync-date", "deploy-date"],
  onInsert: { validFrom: "GETUTCDATE()", validTo: "NULL" },
  onUpdate: { validFrom: "GETUTCDATE()", validTo: "NULL" },
  provenance: { kind: "bundled", templateId: "mymi-abi" },
  version: BUNDLED_VERSION,
  versionLabel: "initial",
  createdBy: BUNDLED_CREATED_BY,
  createdAt: BUNDLED_CREATED_AT
}

/**
 * Minimal SCD2 — just a validity range, no Mymi-specific extras. For
 * customers whose schemas use the same idea more conservatively.
 */
const GENERIC_SCD2: Scd2Strategy = {
  id: "generic-scd2",
  displayName: "Generic SCD2 (validFrom / validTo only)",
  description:
    "Validity range only. validFrom set on insert and update; validTo set to NULL. No identity special-casing; no audit/lock columns.",
  validFromCol: "validFrom",
  validToCol: "validTo",
  isLockedCol: null,
  syncDateCol: null,
  deployDateCol: null,
  identityHandling: "none",
  excludedFromDiffCols: ["validFrom", "validTo"],
  onInsert: { validFrom: "GETUTCDATE()", validTo: "NULL" },
  onUpdate: { validFrom: "GETUTCDATE()", validTo: "NULL" },
  provenance: { kind: "bundled", templateId: "generic-scd2-mssql" },
  version: BUNDLED_VERSION,
  versionLabel: "initial",
  createdBy: BUNDLED_CREATED_BY,
  createdAt: BUNDLED_CREATED_AT
}

/**
 * No SCD2 at all. Used for pure row-replace entities (each sync overwrites
 * matching PKs; no validity range; no metadata columns excluded).
 */
const NONE: Scd2Strategy = {
  id: "none",
  displayName: "No SCD2 (row replace)",
  description:
    "Pure row replace. No validity range, no audit columns, no identity handling. Diff considers every non-PK column.",
  validFromCol: null,
  validToCol: null,
  isLockedCol: null,
  syncDateCol: null,
  deployDateCol: null,
  identityHandling: "none",
  excludedFromDiffCols: [],
  onInsert: {},
  onUpdate: {},
  provenance: { kind: "bundled", templateId: "empty" },
  version: BUNDLED_VERSION,
  versionLabel: "initial",
  createdBy: BUNDLED_CREATED_BY,
  createdAt: BUNDLED_CREATED_AT
}

/**
 * No validity range, but excludes the conventional createdAt/createdBy/
 * modifiedAt/modifiedBy columns from the diff so that touching audit
 * trails doesn't manifest as a syncable change.
 */
const AUDIT_COLS_ONLY: Scd2Strategy = {
  id: "audit-cols-only",
  displayName: "Audit columns excluded (no SCD2)",
  description:
    "No validity range. Excludes createdAt/createdBy/modifiedAt/modifiedBy from diff so audit-only updates do not appear as syncable changes.",
  validFromCol: null,
  validToCol: null,
  isLockedCol: null,
  syncDateCol: null,
  deployDateCol: null,
  identityHandling: "none",
  excludedFromDiffCols: ["createdAt", "createdBy", "modifiedAt", "modifiedBy"],
  onInsert: {},
  onUpdate: {},
  provenance: { kind: "bundled", templateId: "empty" },
  version: BUNDLED_VERSION,
  versionLabel: "initial",
  createdBy: BUNDLED_CREATED_BY,
  createdAt: BUNDLED_CREATED_AT
}

export const BUNDLED_SCD2_STRATEGIES: readonly Scd2Strategy[] = Object.freeze([
  MYMI_SCD2,
  GENERIC_SCD2,
  NONE,
  AUDIT_COLS_ONLY
])

export function bundledStrategyById(id: string): Scd2Strategy | undefined {
  return BUNDLED_SCD2_STRATEGIES.find((s) => s.id === id)
}
