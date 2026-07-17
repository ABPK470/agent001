/**
 * Qualified-name normalization for SQL Server's OBJECT_ID().
 *
 * Handles the persistedView 3-part edge case where 'persistedView.fact.Revenue'
 * means schema=persistedView, object=fact.Revenue.
 *
 * @module
 */

export function normalizePersistredViewName(name: string): string {
  const parts = name.split(".")
  if (parts.length === 3 && parts[0].toLowerCase() === "persistedview") {
    return `[${parts[0]}].[${parts[1]}.${parts[2]}]`
  }
  return name
}

/**
 * Split a 2- or 3-part qualified name into (schema, object). Returns
 * null when the shape is unsupported.
 */
export function splitObjectName(objName: string): { schema: string; name: string } | null {
  const parts = objName.split(".")
  if (parts.length === 2) return { schema: parts[0], name: parts[1] }
  if (parts.length === 3 && parts[0].toLowerCase() === "persistedview") {
    return { schema: parts[0], name: `${parts[1]}.${parts[2]}` }
  }
  return null
}
