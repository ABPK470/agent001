/**
 * SCD2 strategy display + form helpers for Sync Operations.
 */

import type { EntityRegistryStrategy } from "../../types"

export function isTenantCustomStrategy(strategy: EntityRegistryStrategy): boolean {
  return strategy.provenance.kind !== "bundled"
}

export function provenanceLabel(kind: EntityRegistryStrategy["provenance"]["kind"]): string {
  switch (kind) {
    case "bundled": return "Shipped default"
    case "manual": return "Tenant custom"
    case "imported": return "Imported"
    case "agent": return "Agent-generated"
    case "template": return "From template"
    case "legacy-migration": return "Legacy migration"
    default: return kind
  }
}

export const IDENTITY_OPTIONS: {
  value: EntityRegistryStrategy["identityHandling"]
  label: string
}[] = [
  { value: "none", label: "none — no identity special-casing" },
  { value: "setIdentityInsertOn", label: "setIdentityInsertOn — SET IDENTITY_INSERT ON for MERGE" },
  { value: "skipIdentityCols", label: "skipIdentityCols — omit identity columns from sync" },
]

export function colOrNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}

export function formatColList(cols: string[]): string {
  return cols.join(", ")
}

export function parseColList(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function forkOfBundled(seed: EntityRegistryStrategy): EntityRegistryStrategy {
  return {
    ...seed,
    id: seed.id.startsWith("custom-") ? seed.id : `custom-${seed.id}`,
    displayName: `${seed.displayName} (custom)`,
    provenance: { kind: "manual" },
    version: 1,
    versionLabel: "fork",
    createdBy: "",
    createdAt: new Date().toISOString(),
  }
}

export function blankCustomStrategy(): EntityRegistryStrategy {
  return {
    id: "custom-strategy",
    displayName: "Custom strategy",
    description: "",
    validFromCol: null,
    validToCol: null,
    isLockedCol: null,
    syncDateCol: null,
    deployDateCol: null,
    identityHandling: "none",
    excludedFromDiffCols: [],
    onInsert: {},
    onUpdate: {},
    provenance: { kind: "manual" },
    version: 1,
    versionLabel: "initial",
    createdBy: "",
    createdAt: new Date().toISOString(),
  }
}

export interface StrategyRuntimeBullet {
  active: boolean
  text: string
}

/** Human-readable summary of what the strategy document specifies. */
export function describeStrategyEffects(s: EntityRegistryStrategy): StrategyRuntimeBullet[] {
  const bullets: StrategyRuntimeBullet[] = []

  const insertCols = Object.entries(s.onInsert)
  const updateCols = Object.entries(s.onUpdate)

  if (s.validFromCol || s.validToCol || insertCols.length > 0 || updateCols.length > 0) {
    if (insertCols.length > 0) {
      for (const [col, expr] of insertCols) {
        bullets.push({
          active: true,
          text: `On insert, set ${col} = ${expr}`,
        })
      }
    } else if (s.validFromCol) {
      bullets.push({
        active: true,
        text: `On insert, stamp ${s.validFromCol} = GETUTCDATE()`,
      })
    }
    if (updateCols.length > 0) {
      for (const [col, expr] of updateCols) {
        bullets.push({
          active: true,
          text: `On update, set ${col} = ${expr}`,
        })
      }
    } else if (s.validFromCol || s.validToCol) {
      if (s.validFromCol) {
        bullets.push({
          active: true,
          text: `On update, stamp ${s.validFromCol} = GETUTCDATE()`,
        })
      }
      if (s.validToCol) {
        bullets.push({
          active: true,
          text: `On update, set ${s.validToCol} = NULL`,
        })
      }
    }
  } else {
    bullets.push({
      active: false,
      text: "No validity-range stamping (row-replace semantics)",
    })
  }

  if (s.excludedFromDiffCols.length > 0) {
    bullets.push({
      active: true,
      text: `Diff engine excludes: ${s.excludedFromDiffCols.join(", ")}`,
    })
  } else {
    bullets.push({
      active: false,
      text: "Diff compares every non-PK column (no exclusions)",
    })
  }

  if (s.identityHandling !== "none") {
    bullets.push({
      active: true,
      text: `Identity handling: ${s.identityHandling}`,
    })
  }

  const metaCols = [s.isLockedCol, s.syncDateCol, s.deployDateCol].filter(Boolean)
  if (metaCols.length > 0) {
    bullets.push({
      active: true,
      text: `Meta columns tracked: ${metaCols.join(", ")}`,
    })
  }

  return bullets
}

export function strategyFromForm(args: {
  initial: EntityRegistryStrategy
  id: string
  displayName: string
  description: string
  validFromCol: string
  validToCol: string
  isLockedCol: string
  syncDateCol: string
  deployDateCol: string
  identityHandling: EntityRegistryStrategy["identityHandling"]
  excludedFromDiffCols: string
  onInsertJson: string
  onUpdateJson: string
}): EntityRegistryStrategy {
  let onInsert: Record<string, string>
  let onUpdate: Record<string, string>
  try {
    onInsert = JSON.parse(args.onInsertJson) as Record<string, string>
    onUpdate = JSON.parse(args.onUpdateJson) as Record<string, string>
  } catch (e) {
    throw new Error(`onInsert/onUpdate must be valid JSON: ${(e as Error).message}`)
  }
  if (typeof onInsert !== "object" || onInsert === null || Array.isArray(onInsert)) {
    throw new Error("onInsert must be a JSON object")
  }
  if (typeof onUpdate !== "object" || onUpdate === null || Array.isArray(onUpdate)) {
    throw new Error("onUpdate must be a JSON object")
  }

  return {
    ...args.initial,
    id: args.id,
    displayName: args.displayName,
    description: args.description,
    validFromCol: colOrNull(args.validFromCol),
    validToCol: colOrNull(args.validToCol),
    isLockedCol: colOrNull(args.isLockedCol),
    syncDateCol: colOrNull(args.syncDateCol),
    deployDateCol: colOrNull(args.deployDateCol),
    identityHandling: args.identityHandling,
    excludedFromDiffCols: parseColList(args.excludedFromDiffCols),
    onInsert,
    onUpdate,
  }
}
