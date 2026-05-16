/**
 * SCD2 strategy resolution + override merging.
 *
 * Computes the EffectiveScd2 for a given (strategy, entity-level override,
 * table-level override) triple. Pure function; output is snapshotted into
 * the projected Recipe so executes remain reproducible.
 *
 * Merge order (most → least specific):
 *   1. table-level Scd2Override (per `EntityTable.scd2Override`)
 *   2. entity-level Scd2Override (per `EntityDefinition.scd2.entityOverride`)
 *   3. strategy base
 *
 * Override semantics:
 *   - `undefined` key  → fall through to next layer
 *   - `null` value     → explicitly clear (sets the field to null)
 *   - empty array `[]` → explicit empty list (overrides with no exclusions)
 *   - object value     → REPLACES the layer-below dictionary; NOT a merge.
 *     This keeps semantics simple ("per-table strategy") at the cost of
 *     requiring authors to restate the full onInsert/onUpdate maps when
 *     overriding even one column. UI surfaces this clearly.
 */

import type {
  EffectiveScd2,
  EntityTable,
  Scd2Override,
  Scd2Strategy,
} from "./types.js"

export function resolveEffectiveScd2(args: {
  strategy: Scd2Strategy
  entityOverride: Scd2Override | null
  table: EntityTable
}): EffectiveScd2 {
  const { strategy, entityOverride, table } = args
  const tableOverride = table.scd2Override

  const validFromCol   = pickColumn("validFromCol", strategy, entityOverride, tableOverride)
  const validToCol     = pickColumn("validToCol", strategy, entityOverride, tableOverride)
  const isLockedCol    = pickColumn("isLockedCol", strategy, entityOverride, tableOverride)
  const syncDateCol    = pickColumn("syncDateCol", strategy, entityOverride, tableOverride)
  const deployDateCol  = pickColumn("deployDateCol", strategy, entityOverride, tableOverride)

  const identityHandling = pickEnum(
    "identityHandling",
    strategy,
    entityOverride,
    tableOverride,
  )

  const excludedFromDiffCols = pickArray("excludedFromDiffCols", strategy, entityOverride, tableOverride)
  const onInsert = pickDict("onInsert", strategy, entityOverride, tableOverride)
  const onUpdate = pickDict("onUpdate", strategy, entityOverride, tableOverride)

  return {
    validFromCol,
    validToCol,
    isLockedCol,
    syncDateCol,
    deployDateCol,
    identityHandling,
    excludedFromDiffCols,
    onInsert,
    onUpdate,
    resolution: {
      strategyId: strategy.id,
      strategyVersion: strategy.version,
      entityOverrideApplied: !isEmptyOverride(entityOverride),
      tableOverrideApplied: !isEmptyOverride(tableOverride),
    },
  }
}

// ── Helpers ──────────────────────────────────────────────────────

type ColumnField = "validFromCol" | "validToCol" | "isLockedCol" | "syncDateCol" | "deployDateCol"

function pickColumn(
  field: ColumnField,
  strategy: Scd2Strategy,
  entityOverride: Scd2Override | null,
  tableOverride: Scd2Override | null,
): string | null {
  if (tableOverride && field in tableOverride) {
    const v = tableOverride[field]
    if (v !== undefined) return v
  }
  if (entityOverride && field in entityOverride) {
    const v = entityOverride[field]
    if (v !== undefined) return v
  }
  return strategy[field]
}

function pickEnum(
  field: "identityHandling",
  strategy: Scd2Strategy,
  entityOverride: Scd2Override | null,
  tableOverride: Scd2Override | null,
): Scd2Strategy["identityHandling"] {
  if (tableOverride && tableOverride[field] !== undefined) return tableOverride[field]!
  if (entityOverride && entityOverride[field] !== undefined) return entityOverride[field]!
  return strategy[field]
}

function pickArray(
  field: "excludedFromDiffCols",
  strategy: Scd2Strategy,
  entityOverride: Scd2Override | null,
  tableOverride: Scd2Override | null,
): string[] {
  if (tableOverride && tableOverride[field] !== undefined) return [...tableOverride[field]!]
  if (entityOverride && entityOverride[field] !== undefined) return [...entityOverride[field]!]
  return [...strategy[field]]
}

function pickDict(
  field: "onInsert" | "onUpdate",
  strategy: Scd2Strategy,
  entityOverride: Scd2Override | null,
  tableOverride: Scd2Override | null,
): Record<string, string> {
  if (tableOverride && tableOverride[field] !== undefined) return { ...tableOverride[field]! }
  if (entityOverride && entityOverride[field] !== undefined) return { ...entityOverride[field]! }
  return { ...strategy[field] }
}

function isEmptyOverride(o: Scd2Override | null): boolean {
  if (o === null) return true
  return Object.values(o).every((v) => v === undefined)
}
