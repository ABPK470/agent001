import type { PublishedSyncDefinition, SyncEntityType } from "../../types"

export const ENTITY_TYPES: SyncEntityType[] = [
  "contract", "dataset", "rule", "pipelineActivity", "gateMetadata", "content",
]

export function definitionDefaultOptionalTables(definition: PublishedSyncDefinition | null): string[] {
  if (!definition) return []
  return definition.metadata.tables
    .filter((table) => table.userControllable && table.enabledByDefault)
    .map((table) => table.name)
}

export function normalizeOptionalTableSelection(definition: PublishedSyncDefinition | null, selected: string[] | null): string[] {
  if (!definition) return Array.isArray(selected) ? [...selected] : []
  const allowed = new Set(definition.metadata.tables.filter((table) => table.userControllable).map((table) => table.name))
  const base = Array.isArray(selected) ? selected : definitionDefaultOptionalTables(definition)
  return base.filter((tableName, index, arr) => allowed.has(tableName) && arr.indexOf(tableName) === index)
}

export function dot(c: string): string {
  const m: Record<string, string> = {
    slate:   "var(--color-text-muted)",
    blue:    "var(--color-accent-soft)",
    teal:    "var(--color-accent)",
    indigo:  "var(--color-accent-hover)",
    pink:    "var(--color-accent-soft)",
    cyan:    "var(--color-accent)",
    amber:   "var(--color-accent-soft)",
    emerald: "var(--color-accent)",
    rose:    "var(--color-accent-hover)",
  }
  return m[c] ?? "var(--color-text-muted)"
}

export const DIFF = {
  ins:    "var(--color-accent)",
  upd:    "var(--color-viz-peach)",
  del:    "var(--color-viz-coral)",
  eqDim:  "var(--color-text-muted)",
  oldRow: "var(--color-text-muted)",
  newRow: "var(--color-accent)",
} as const