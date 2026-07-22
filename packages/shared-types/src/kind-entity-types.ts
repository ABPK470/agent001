/**
 * Which entity types may use a sync Action (step kind).
 *
 * Stored on SyncFlowKindDefinition.entityTypes. Publish validates flows
 * against this list. "any" means every entity type.
 */

export const SYNC_FLOW_KIND_ENTITY_TYPES = [
  "any",
  "contract",
  "dataset",
  "rule",
  "content",
  "pipelineActivity",
  "gateMetadata",
] as const

export type SyncFlowKindEntityType = (typeof SYNC_FLOW_KIND_ENTITY_TYPES)[number]

/** Concrete entity ids (excludes the "any" wildcard). */
export const SYNC_FLOW_KIND_SCOPED_ENTITY_TYPES = SYNC_FLOW_KIND_ENTITY_TYPES.filter(
  (value): value is Exclude<SyncFlowKindEntityType, "any"> => value !== "any",
)

const ENTITY_TYPE_SET = new Set<string>(SYNC_FLOW_KIND_ENTITY_TYPES)

export function isSyncFlowKindEntityType(value: string): value is SyncFlowKindEntityType {
  return ENTITY_TYPE_SET.has(value)
}

/**
 * Normalize a multi-select: empty → ["any"]; "any" is exclusive with scoped types.
 * When both appear, the last selected value wins (matches FilterToggles add order).
 */
export function normalizeSyncFlowKindEntityTypes(
  selected: readonly string[],
): SyncFlowKindEntityType[] {
  const known = selected.filter(isSyncFlowKindEntityType)
  if (known.length === 0) return ["any"]

  const last = known[known.length - 1]!
  if (last === "any") return ["any"]

  const scoped = [...new Set(known.filter((value) => value !== "any"))]
  return scoped.length > 0 ? scoped : ["any"]
}

/** True when an Action's entityTypes allow the given entity id. */
export function kindAllowsEntityType(
  entityTypes: readonly SyncFlowKindEntityType[] | undefined,
  entityId: string,
): boolean {
  const allowed = entityTypes?.length ? entityTypes : (["any"] as const)
  if (allowed.includes("any")) return true
  return allowed.includes(entityId as SyncFlowKindEntityType)
}
