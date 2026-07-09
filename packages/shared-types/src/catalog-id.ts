/**
 * Catalog id convention — step kinds, phases, flow step instance ids, custom value source ids.
 *
 * camelCase starting with a lowercase letter: `metadataSync`, `preTransaction`.
 */

export const CATALOG_ID_PATTERN = /^[a-z][a-zA-Z0-9]*$/

export function isCatalogId(id: string): boolean {
  const trimmed = id.trim()
  return trimmed.length > 0 && CATALOG_ID_PATTERN.test(trimmed)
}

export function validateCatalogId(id: string, label = "Id"): string | null {
  const trimmed = id.trim()
  if (!trimmed) return `${label} is required.`
  if (!isCatalogId(trimmed)) {
    return `${label} must be camelCase starting with a lowercase letter (e.g. metadataSync, preTransaction).`
  }
  return null
}

/** Kind id for the single metadata transaction step every flow must include. */
export const METADATA_SYNC_KIND_ID = "metadataSync"

export function idToCatalogLabel(id: string): string {
  const trimmed = id.trim()
  if (!trimmed) return ""
  return trimmed
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

export function idToCatalogDescription(
  id: string,
  kind: "stepType" | "flow" | "customValueSource",
): string {
  const label = idToCatalogLabel(id)
  if (!label) return ""
  if (kind === "flow") return `${label} execution flow.`
  if (kind === "customValueSource") return `${label} — custom SQL value source for handler inputs.`
  return `${label} kind.`
}
