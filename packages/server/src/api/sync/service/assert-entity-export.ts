/**
 * Server export boundary — fail before serializing corrupt registry rows.
 */

import type { EntityDefinition, ValidationResult } from "@mia/sync"
import { validateEntityExportable } from "@mia/sync"

import * as db from "../../../infra/persistence/sqlite.js"

export class EntityExportValidationError extends Error {
  readonly name = "EntityExportValidationError"

  constructor(
    readonly entityId: string,
    readonly result: ValidationResult,
  ) {
    const detail = result.errors.map((issue) => issue.message).join("; ")
    super(`entity "${entityId}" is not exportable: ${detail}`)
  }
}

export function assertEntityExportable(def: EntityDefinition): void {
  const result = validateEntityExportable(def)
  if (!result.ok) {
    throw new EntityExportValidationError(def.id, result)
  }
}

export async function assertTenantEntitiesExportable(
  tenantId: string,
  options: { includeRetired?: boolean } = {},
): Promise<void> {
  for (const def of await db.listEntityDefinitions(tenantId, {
    includeRetired: options.includeRetired ?? false,
  })) {
    assertEntityExportable(def)
  }
}
