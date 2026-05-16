/**
 * Smart-defaults helpers for the entity authoring surfaces.
 *
 * The UI nudges humans away from typing identifiers — the operator
 * picks a real-world table, and we derive the kebab-case `id`, a
 * sensible `displayName`, and a best-guess `idColumn` so the
 * "required" set collapses to a single meaningful field.
 */

/**
 * Derive a kebab-case id from a (possibly schema-qualified) table name.
 *
 *   "core.Contract"     → "contract"
 *   "coreOrders"        → "core-orders"
 *   "DimEmployeeRole"   → "dim-employee-role"
 *   "ods.HR_Employee"   → "hr-employee"
 */
export function deriveEntityId(rootTable: string): string {
  const tail = rootTable.split(".").pop() ?? rootTable
  return tail
    .replace(/[_\s]+/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || ""
}

/**
 * Derive a human-friendly display name from a table name.
 *
 *   "core.Contract"    → "Contract"
 *   "DimEmployeeRole"  → "Dim Employee Role"
 *   "hr_employee"      → "Hr Employee"
 */
export function deriveDisplayName(rootTable: string): string {
  const tail = rootTable.split(".").pop() ?? rootTable
  return tail
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * Best-effort guess at the primary-key column for a root table.
 *
 *   "core.Contract"  → "contractId"
 *   "DimUser"        → "dimUserId"
 *   "hr_employee"    → "hrEmployeeId"
 */
export function deriveIdColumn(rootTable: string): string {
  const tail = rootTable.split(".").pop() ?? rootTable
  // Convert to camelCase first, then append "Id".
  const camel = tail
    .replace(/[_-]+(.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^[A-Z]/, (c) => c.toLowerCase())
  if (!camel) return ""
  return /[Ii]d$/.test(camel) ? camel : `${camel}Id`
}
