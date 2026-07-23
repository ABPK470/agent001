/**
 * Export guards — registry rows and authored artifacts must be import-safe.
 */

import type { AuthoredSyncDefinition } from "@mia/shared-types"

import { entityDefinitionFromAuthoredSync } from "./from-authored-sync.js"
import { projectTablePredicate } from "./project-predicate.js"
import {
  isDegradedLegacyFallbackPredicate,
  looksIncompleteScopePredicate,
} from "./resolve-scope-predicate.js"
import type { EntityDefinition, ValidationError, ValidationResult, ValidationWarning } from "./types.js"
import { validateEntityDefinition } from "./validate.js"

/** Structural validation every export path must pass before serializing. */
export function validateEntityExportable(def: EntityDefinition): ValidationResult {
  return validateEntityDefinition(def)
}

/**
 * Authored artifact export must round-trip through the import compiler without
 * predicate drift or placeholder/degraded scopes.
 */
export function validateAuthoredExportRoundTrip(
  source: EntityDefinition,
  authored: AuthoredSyncDefinition,
  tenantId = source.tenantId,
): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  const reimported = entityDefinitionFromAuthoredSync(authored, tenantId)
  const structural = validateEntityDefinition(reimported)
  errors.push(...structural.errors)
  warnings.push(...structural.warnings)

  const exportedByName = new Map(authored.metadata.tables.map((table) => [table.name, table]))
  for (const table of source.tables) {
    const expected = projectTablePredicate(source, table)
    const exportedTable = exportedByName.get(table.name)
    if (!exportedTable) {
      errors.push({
        code: "table_missing",
        message: `Export omits table "${table.name}".`,
        path: "/metadata/tables",
      })
      continue
    }
    if (exportedTable.predicate !== expected) {
      errors.push({
        code: "predicate_drift",
        message: `Export predicate for "${table.name}" drifted from registry scope.`,
        path: `/metadata/tables/${table.name}/predicate`,
      })
    }
    if (looksIncompleteScopePredicate(exportedTable.predicate)) {
      errors.push({
        code: "scope_incomplete",
        message: `Export predicate for "${table.name}" is incomplete or contains review placeholders.`,
        path: `/metadata/tables/${table.name}/predicate`,
      })
    }
    if (isDegradedLegacyFallbackPredicate(exportedTable.predicate)) {
      errors.push({
        code: "scope_degraded_legacy",
        message: `Export predicate for "${table.name}" uses a degraded IN-list fallback.`,
        path: `/metadata/tables/${table.name}/predicate`,
      })
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}
