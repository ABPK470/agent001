/**
 * SCD2 strategy display + form helpers for Sync Operations.
 */

import type { EntityRegistryStrategy } from "../../../types"

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
  hint: string
}[] = [
  {
    value: "none",
    label: "Copy from source",
    hint: "Identity PK values are copied from source when present (SET IDENTITY_INSERT when required).",
  },
  {
    value: "setIdentityInsertOn",
    label: "Explicit identity insert",
    hint: "Wrap MERGE with SET IDENTITY_INSERT ON/OFF when the target has an identity PK.",
  },
  {
    value: "omit-identity-column",
    label: "Omit identity column",
    hint: "Never write the identity PK column — target generates it.",
  },
]

export const STRATEGY_PRESETS: {
  id: string
  label: string
  description: string
  strategy: Pick<EntityRegistryStrategy, "excludeFromDiff" | "onInsert" | "onUpdate" | "identityHandling">
}[] = [
  {
    id: "blank",
    label: "Blank",
    description: "Diff all non-PK columns; no automatic stamps.",
    strategy: { excludeFromDiff: [], onInsert: {}, onUpdate: {}, identityHandling: "none" },
  },
  {
    id: "validity-range",
    label: "Validity range",
    description: "Classic validFrom/validTo stamping (target-dialect SQL).",
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
    description: "Validity + lock/sync/deploy audit columns excluded from diff.",
    strategy: {
      excludeFromDiff: ["validFrom", "validTo", "isLocked", "sync-date", "deploy-date"],
      onInsert: { validFrom: "GETUTCDATE()", validTo: "NULL" },
      onUpdate: { validFrom: "GETUTCDATE()", validTo: "NULL" },
      identityHandling: "setIdentityInsertOn",
    },
  },
  {
    id: "audit-cols",
    label: "Audit columns only",
    description: "Exclude created/modified audit columns; no validity stamping.",
    strategy: {
      excludeFromDiff: ["createdAt", "createdBy", "modifiedAt", "modifiedBy"],
      onInsert: {},
      onUpdate: {},
      identityHandling: "none",
    },
  },
]

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
    excludeFromDiff: [],
    identityHandling: "none",
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

  if (s.excludeFromDiff.length > 0) {
    bullets.push({
      active: true,
      text: `Diff excludes: ${s.excludeFromDiff.join(", ")}`,
    })
  } else {
    bullets.push({
      active: false,
      text: "Diff compares every non-PK column (no exclusions)",
    })
  }

  const insertCols = Object.entries(s.onInsert)
  const updateCols = Object.entries(s.onUpdate)
  if (insertCols.length > 0 || updateCols.length > 0) {
    for (const [col, expr] of insertCols) {
      bullets.push({ active: true, text: `On insert: ${col} = ${expr}` })
    }
    for (const [col, expr] of updateCols) {
      bullets.push({ active: true, text: `On update: ${col} = ${expr}` })
    }
  } else {
    bullets.push({
      active: false,
      text: "No stamp expressions — values come from source only",
    })
  }

  if (s.identityHandling !== "none") {
    const label = IDENTITY_OPTIONS.find((o) => o.value === s.identityHandling)?.label ?? s.identityHandling
    bullets.push({ active: true, text: `Identity: ${label}` })
  }

  return bullets
}

export function strategyFromForm(args: {
  initial: EntityRegistryStrategy
  id: string
  displayName: string
  description: string
  identityHandling: EntityRegistryStrategy["identityHandling"]
  excludeFromDiff: string
  onInsertJson: string
  onUpdateJson: string
}): EntityRegistryStrategy {
  let onInsert: Record<string, string>
  let onUpdate: Record<string, string>
  try {
    onInsert = JSON.parse(args.onInsertJson) as Record<string, string>
    onUpdate = JSON.parse(args.onUpdateJson) as Record<string, string>
  } catch (e) {
    throw new Error(`On insert / on update must be valid JSON: ${(e as Error).message}`)
  }
  if (typeof onInsert !== "object" || onInsert === null || Array.isArray(onInsert)) {
    throw new Error("On insert must be a JSON object")
  }
  if (typeof onUpdate !== "object" || onUpdate === null || Array.isArray(onUpdate)) {
    throw new Error("On update must be a JSON object")
  }

  return {
    ...args.initial,
    id: args.id,
    displayName: args.displayName,
    description: args.description,
    identityHandling: args.identityHandling,
    excludeFromDiff: parseColList(args.excludeFromDiff),
    onInsert,
    onUpdate,
  }
}
