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

/** Case-insensitive column lookup; returns the policy spelling when present on the table. */
export function resolveColumnOnTable(requested: string, available: Iterable<string>): string | null {
  const lower = requested.trim().toLowerCase()
  if (!lower) return null
  for (const col of available) {
    if (col.trim().toLowerCase() === lower) return requested.trim()
  }
  return null
}

export interface Scd2PolicySchemaOmissions {
  excludeFromDiff: string[]
  onInsert: string[]
  onUpdate: string[]
}

/**
 * Ground-truth SCD2 policy for one table: intersect strategy/template fields with
 * live source (diff exclusions) and target (MERGE stamps) columns.
 * Strategy presets may name validFrom/validTo/etc.; omit anything absent on this table.
 */
export function materializeScd2PolicyForSchema(
  base: Scd2TablePolicy,
  sourceColumns: Iterable<string>,
  targetColumns: Iterable<string>,
): { policy: Scd2TablePolicy; omitted: Scd2PolicySchemaOmissions } {
  const src = [...sourceColumns]
  const tgt = [...targetColumns]

  const excludeFromDiff: string[] = []
  const omittedExclude: string[] = []
  for (const col of base.excludeFromDiff) {
    if (resolveColumnOnTable(col, src)) excludeFromDiff.push(col.trim())
    else omittedExclude.push(col.trim())
  }

  const onInsert: Record<string, string> = {}
  const omittedInsert: string[] = []
  for (const [col, expr] of Object.entries(base.onInsert)) {
    if (resolveColumnOnTable(col, tgt)) onInsert[col.trim()] = expr
    else omittedInsert.push(col.trim())
  }

  const onUpdate: Record<string, string> = {}
  const omittedUpdate: string[] = []
  for (const [col, expr] of Object.entries(base.onUpdate)) {
    if (resolveColumnOnTable(col, tgt)) onUpdate[col.trim()] = expr
    else omittedUpdate.push(col.trim())
  }

  return {
    policy: {
      excludeFromDiff: dedupeColumns(excludeFromDiff),
      onInsert,
      onUpdate,
      identityHandling: base.identityHandling,
    },
    omitted: {
      excludeFromDiff: dedupeColumns(omittedExclude),
      onInsert: dedupeColumns(omittedInsert),
      onUpdate: dedupeColumns(omittedUpdate),
    },
  }
}

export function formatScd2PolicyOmissionSummary(
  tableName: string,
  omitted: Scd2PolicySchemaOmissions,
): string | null {
  const parts: string[] = []
  if (omitted.excludeFromDiff.length > 0) {
    parts.push(`excludeFromDiff: ${omitted.excludeFromDiff.join(", ")}`)
  }
  if (omitted.onInsert.length > 0) parts.push(`onInsert: ${omitted.onInsert.join(", ")}`)
  if (omitted.onUpdate.length > 0) parts.push(`onUpdate: ${omitted.onUpdate.join(", ")}`)
  if (parts.length === 0) return null
  return `${tableName} — strategy columns not on this table (${parts.join("; ")})`
}

/** Keep only stamp expressions for columns that exist on the target table. */
export function filterPolicyStampsToTargetColumns(
  stamps: Record<string, string>,
  targetColumns: Iterable<string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [col, expr] of Object.entries(stamps)) {
    if (resolveColumnOnTable(col, targetColumns)) out[col.trim()] = expr
  }
  return out
}

export function scd2PolicyTargetColumnIssues(
  tableName: string,
  policy: Pick<Scd2TablePolicy, "onInsert" | "onUpdate">,
  targetColumns: Iterable<string>,
): string[] {
  const omitted = materializeScd2PolicyForSchema(
    {
      excludeFromDiff: [],
      onInsert: policy.onInsert,
      onUpdate: policy.onUpdate,
      identityHandling: "none",
    },
    [],
    targetColumns,
  ).omitted
  const issues: string[] = []
  for (const col of omitted.onInsert) {
    issues.push(`${tableName}.${col}: stamp column absent on target (omitted at runtime)`)
  }
  for (const col of omitted.onUpdate) {
    issues.push(`${tableName}.${col}: stamp column absent on target (omitted at runtime)`)
  }
  return [...new Set(issues)]
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
