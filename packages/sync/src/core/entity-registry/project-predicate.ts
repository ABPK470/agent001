/**
 * Shared table-scope → SQL predicate projection.
 *
 * Used by scaffold, publish (compose), and recipe projector so all compilers
 * emit identical predicates for the same EntityDefinition input.
 */

import type { EntityDefinition, EntityTable } from "../../domain/entity-registry/types.js"

export function projectTablePredicate(entity: EntityDefinition, table: EntityTable): string {
  const scope = table.scope
  if (!scope || typeof scope !== "object" || typeof scope.kind !== "string") {
    throw new Error(`Table ${String(table.name)} is missing a valid scope definition.`)
  }
  const hasSelfJoin = typeof entity.selfJoinColumn === "string" && entity.selfJoinColumn.trim().length > 0
  switch (scope.kind) {
    case "rootPk": {
      const op = hasSelfJoin ? " IN ({ids})" : " = {id}"
      return `${quoteIdentifier(scope.column)}${op}`
    }
    case "sql":
      return String(scope.predicate)
    case "fkPath":
      throw new Error(
        `Table ${String(table.name)} still has legacy fkPath scope — normalize the entity definition before compile.`,
      )
    default:
      throw new Error(`Unsupported scope kind for table ${String(table.name)}.`)
  }
}

function quoteIdentifier(identifier: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier) ? identifier : `[${identifier}]`
}
