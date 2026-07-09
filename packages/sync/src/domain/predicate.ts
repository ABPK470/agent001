/**
 * Predicate instantiation helpers for sync scope templates.
 */

/** Substitute `{id}` placeholders in a predicate template. */
export function instantiatePredicate(predicate: string, entityId: string | number): string {
  const literal =
    typeof entityId === "number" ? String(entityId) : `'${String(entityId).replace(/'/g, "''")}'`
  return predicate.replace(/\{id\}/g, literal)
}

/**
 * Substitute both `{id}` (single root) and `{ids}` (expanded tree) placeholders.
 * When `expandedIds` is null or empty, `{ids}` falls back to the single `{id}`.
 */
export function instantiatePredicateWithTree(
  predicate: string,
  entityId: string | number,
  expandedIds: Array<string | number> | null
): string {
  const literal =
    typeof entityId === "number" ? String(entityId) : `'${String(entityId).replace(/'/g, "''")}'`
  const effectiveIds = expandedIds && expandedIds.length > 0 ? expandedIds : [entityId]
  const idsLiteral = effectiveIds
    .map((id) => (typeof id === "number" ? String(id) : `'${String(id).replace(/'/g, "''")}'`))
    .join(", ")
  return predicate.replace(/\{ids\}/g, idsLiteral).replace(/\{id\}/g, literal)
}

/** Map a source table to its SCD2 archive sibling by ABI convention. */
export function deriveArchiveTable(qualifiedName: string): string | null {
  const [schema, name] = qualifiedName.split(".")
  if (!schema || !name) return null
  if (schema === "master") return null
  if (schema.endsWith("Archive")) return null
  return `${schema}Archive.${name}`
}
