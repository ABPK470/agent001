/**
 * SCD2 strategy resolution + override merging.
 */

import { asStrategyId } from "../../domain/types/branded-ids.js"

import { normalizeScd2Override, normalizeScd2Strategy } from "./scd2-policy.js"
import type { EffectiveScd2, EntityTable, Scd2Override, Scd2Strategy } from "../../domain/entity-registry/types.js"

export function resolveEffectiveScd2(args: {
  strategy: Scd2Strategy
  entityOverride: Scd2Override | null
  table: EntityTable
}): EffectiveScd2 {
  const strategy = normalizeScd2Strategy(args.strategy)
  const entityOverride = normalizeScd2Override(args.entityOverride)
  const tableOverride = normalizeScd2Override(args.table.scd2Override)

  const excludeFromDiff = pickArray("excludeFromDiff", strategy, entityOverride, tableOverride)
  const onInsert = pickDict("onInsert", strategy, entityOverride, tableOverride)
  const onUpdate = pickDict("onUpdate", strategy, entityOverride, tableOverride)
  const identityHandling = pickEnum("identityHandling", strategy, entityOverride, tableOverride)

  return {
    excludeFromDiff,
    onInsert,
    onUpdate,
    identityHandling,
    resolution: {
      strategyId: asStrategyId(strategy.id),
      strategyVersion: strategy.version,
      entityOverrideApplied: !isEmptyOverride(entityOverride),
      tableOverrideApplied: !isEmptyOverride(tableOverride),
    },
  }
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
  field: "excludeFromDiff",
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
