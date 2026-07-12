/**
 * SCD2 policy — first-principles column-handling contract.
 *
 * A strategy is a reusable policy document:
 *   - which columns are excluded from content diff
 *   - which target-side expressions to apply on insert/update
 *   - how to treat identity PK columns during MERGE
 *
 * No baked-in validity/meta column roles — those are just presets that compile
 * into excludeFromDiff + onInsert/onUpdate.
 */

import type { Scd2Override, Scd2Strategy } from "./types.js"

export type Scd2IdentityHandling = "none" | "setIdentityInsertOn" | "omit-identity-column"

/** Runtime + publish-time policy frozen per table. */
export interface Scd2TablePolicy {
  excludeFromDiff: string[]
  onInsert: Record<string, string>
  onUpdate: Record<string, string>
  identityHandling: Scd2IdentityHandling
}

/** Legacy persisted shape (pre-policy refactor). */
export interface LegacyScd2StrategyFields {
  validFromCol?: string | null
  validToCol?: string | null
  isLockedCol?: string | null
  syncDateCol?: string | null
  deployDateCol?: string | null
  excludedFromDiffCols?: string[]
}

export function isScd2TablePolicy(value: unknown): value is Scd2TablePolicy {
  if (!value || typeof value !== "object") return false
  const row = value as Record<string, unknown>
  return Array.isArray(row.excludeFromDiff)
    && row.onInsert != null && typeof row.onInsert === "object"
    && row.onUpdate != null && typeof row.onUpdate === "object"
    && typeof row.identityHandling === "string"
}

export function normalizeIdentityHandling(value: unknown): Scd2IdentityHandling {
  if (value === "setIdentityInsertOn") return "setIdentityInsertOn"
  if (value === "omit-identity-column" || value === "skipIdentityCols" || value === "preserveSequence") {
    return "omit-identity-column"
  }
  return "none"
}

/** Read legacy or new strategy JSON into the canonical policy fields. */
export function normalizeScd2Strategy<T extends Scd2Strategy>(strategy: T): Scd2Strategy {
  const legacy = strategy as Scd2Strategy & LegacyScd2StrategyFields
  if (Array.isArray(legacy.excludeFromDiff)) {
    return {
      ...strategy,
      excludeFromDiff: dedupeColumns(legacy.excludeFromDiff),
      onInsert: { ...strategy.onInsert },
      onUpdate: { ...strategy.onUpdate },
      identityHandling: normalizeIdentityHandling(strategy.identityHandling),
    }
  }

  const exclude = new Set<string>(legacy.excludedFromDiffCols ?? [])
  for (const col of [
    legacy.validFromCol,
    legacy.validToCol,
    legacy.isLockedCol,
    legacy.syncDateCol,
    legacy.deployDateCol,
  ]) {
    if (col) exclude.add(col)
  }

  return {
    ...strategy,
    excludeFromDiff: dedupeColumns([...exclude]),
    onInsert: { ...strategy.onInsert },
    onUpdate: { ...strategy.onUpdate },
    identityHandling: normalizeIdentityHandling(strategy.identityHandling),
  }
}

export function normalizeScd2Override(override: Scd2Override | null): Scd2Override | null {
  if (!override) return null
  const legacy = override as Scd2Override & LegacyScd2StrategyFields
  if (legacy.excludeFromDiff !== undefined) {
    return {
      excludeFromDiff: legacy.excludeFromDiff ? [...legacy.excludeFromDiff] : [],
      onInsert: legacy.onInsert ? { ...legacy.onInsert } : undefined,
      onUpdate: legacy.onUpdate ? { ...legacy.onUpdate } : undefined,
      identityHandling: legacy.identityHandling !== undefined
        ? normalizeIdentityHandling(legacy.identityHandling)
        : undefined,
    }
  }

  const out: Scd2Override = {}
  if (legacy.excludedFromDiffCols !== undefined) out.excludeFromDiff = [...legacy.excludedFromDiffCols]
  if (legacy.onInsert !== undefined) out.onInsert = { ...legacy.onInsert }
  if (legacy.onUpdate !== undefined) out.onUpdate = { ...legacy.onUpdate }
  if (legacy.identityHandling !== undefined) {
    out.identityHandling = normalizeIdentityHandling(legacy.identityHandling)
  }

  const extraCols = [
    legacy.validFromCol,
    legacy.validToCol,
    legacy.isLockedCol,
    legacy.syncDateCol,
    legacy.deployDateCol,
  ].filter((c): c is string => Boolean(c))

  if (extraCols.length > 0) {
    const merged = new Set([...(out.excludeFromDiff ?? legacy.excludedFromDiffCols ?? []), ...extraCols])
    out.excludeFromDiff = [...merged]
  }

  return Object.keys(out).length > 0 ? out : null
}

export function toScd2TablePolicy(policy: Pick<Scd2Strategy, "excludeFromDiff" | "onInsert" | "onUpdate" | "identityHandling">): Scd2TablePolicy {
  return {
    excludeFromDiff: dedupeColumns(policy.excludeFromDiff),
    onInsert: { ...policy.onInsert },
    onUpdate: { ...policy.onUpdate },
    identityHandling: normalizeIdentityHandling(policy.identityHandling),
  }
}

export function dedupeColumns(columns: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const col of columns) {
    const trimmed = col.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

export interface Scd2StrategyPreset {
  id: string
  label: string
  description: string
  strategy: Omit<Scd2Strategy, "id" | "displayName" | "description" | "provenance" | "version" | "versionLabel" | "createdBy" | "createdAt">
}

export const SCD2_STRATEGY_PRESETS: readonly Scd2StrategyPreset[] = [
  {
    id: "blank",
    label: "Blank",
    description: "Row-replace semantics — diff all non-PK columns, no automatic stamps.",
    strategy: {
      excludeFromDiff: [],
      onInsert: {},
      onUpdate: {},
      identityHandling: "none",
    },
  },
  {
    id: "validity-range",
    label: "Validity range",
    description: "Classic validFrom/validTo SCD2 stamping (expressions are target-dialect SQL).",
    strategy: {
      excludeFromDiff: ["validFrom", "validTo"],
      onInsert: { validFrom: "GETUTCDATE()", validTo: "NULL" },
      onUpdate: { validFrom: "GETUTCDATE()", validTo: "NULL" },
      identityHandling: "none",
    },
  },
  {
    id: "mymi-abi",
    label: "Mymi ABI preset",
    description: "Validity range plus lock/sync/deploy audit columns excluded from diff.",
    strategy: {
      excludeFromDiff: ["validFrom", "validTo", "isLocked", "syncDate", "deployDate"],
      onInsert: { validFrom: "GETUTCDATE()", validTo: "NULL" },
      onUpdate: { validFrom: "GETUTCDATE()", validTo: "NULL" },
      identityHandling: "setIdentityInsertOn",
    },
  },
  {
    id: "audit-cols",
    label: "Audit columns only",
    description: "Exclude created/modified audit columns from diff; no validity stamping.",
    strategy: {
      excludeFromDiff: ["createdAt", "createdBy", "modifiedAt", "modifiedBy"],
      onInsert: {},
      onUpdate: {},
      identityHandling: "none",
    },
  },
] as const
