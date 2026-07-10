/**
 * Bundled SCD2 strategy defaults — shipped with the product, seeded into
 * `_default` tenant on first boot. Each preset is a plain policy document
 * (excludeFromDiff + stamp maps) with no special-case column roles.
 */

import type { Scd2Strategy } from "./types.js"

const BASE = {
  version: 1,
  versionLabel: "initial",
  createdBy: "system",
  createdAt: "2026-01-01T00:00:00.000Z",
} as const

const MYMI_SCD2: Scd2Strategy = {
  id: "mymi-scd2",
  displayName: "Mymi ABI SCD2",
  description: "Validity range + lock/sync/deploy audit columns excluded from diff; identity insert enabled.",
  excludeFromDiff: ["validFrom", "validTo", "isLocked", "sync-date", "deploy-date"],
  onInsert: { validFrom: "GETUTCDATE()", validTo: "NULL" },
  onUpdate: { validFrom: "GETUTCDATE()", validTo: "NULL" },
  identityHandling: "setIdentityInsertOn",
  provenance: { kind: "bundled", templateId: "mymi-abi" },
  ...BASE,
}

const GENERIC_SCD2: Scd2Strategy = {
  id: "generic-scd2",
  displayName: "Generic validity-range SCD2",
  description: "validFrom/validTo stamping only — no extra audit columns.",
  excludeFromDiff: ["validFrom", "validTo"],
  onInsert: { validFrom: "GETUTCDATE()", validTo: "NULL" },
  onUpdate: { validFrom: "GETUTCDATE()", validTo: "NULL" },
  identityHandling: "none",
  provenance: { kind: "bundled", templateId: "generic-scd2-mssql" },
  ...BASE,
}

const NONE: Scd2Strategy = {
  id: "none",
  displayName: "None (row replace)",
  description: "No SCD2 stamping — full row replace semantics.",
  excludeFromDiff: [],
  onInsert: {},
  onUpdate: {},
  identityHandling: "none",
  provenance: { kind: "bundled", templateId: "empty" },
  ...BASE,
}

const AUDIT_COLS_ONLY: Scd2Strategy = {
  id: "audit-cols-only",
  displayName: "Audit columns only",
  description: "Exclude created/modified audit columns from diff; no validity stamping.",
  excludeFromDiff: ["createdAt", "createdBy", "modifiedAt", "modifiedBy"],
  onInsert: {},
  onUpdate: {},
  identityHandling: "none",
  provenance: { kind: "bundled", templateId: "empty" },
  ...BASE,
}

export const BUNDLED_SCD2_STRATEGIES: readonly Scd2Strategy[] = Object.freeze([
  MYMI_SCD2,
  GENERIC_SCD2,
  NONE,
  AUDIT_COLS_ONLY,
])

export function bundledStrategyById(id: string): Scd2Strategy | undefined {
  return BUNDLED_SCD2_STRATEGIES.find((s) => s.id === id)
}
