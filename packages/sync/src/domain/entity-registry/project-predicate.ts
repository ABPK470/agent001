/**
 * Shared table-scope → SQL predicate projection.
 *
 * Used by scaffold, publish (compose), and recipe projector so all compilers
 * emit identical predicates for the same EntityDefinition input.
 */

import type { EntityDefinition, EntityTable } from "./types.js"

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
    case "fkPath": {
      const through = Array.isArray(scope.through) ? scope.through : []
      if (through.length === 0) throw new Error(`Table ${String(table.name)} has fkPath scope with no hops.`)
      const aliases = through.map((_, index) => `h${index}`)
      const joins: string[] = []
      for (let index = 0; index < through.length; index++) {
        const hop = through[index]!
        const alias = aliases[index]!
        if (index === 0) {
          joins.push(`FROM ${hop.table} AS ${alias}`)
        } else {
          const previousAlias = aliases[index - 1]!
          const previousHop = through[index - 1]!
          joins.push(
            `JOIN ${hop.table} AS ${alias} ON ${alias}.${quoteIdentifier(hop.toColumn)} = ${previousAlias}.${quoteIdentifier(previousHop.fromColumn)}`
          )
        }
      }
      const firstHop = through[0]!
      const lastHop = through[through.length - 1]!
      const lastAlias = aliases[aliases.length - 1]!
      const op = hasSelfJoin ? " IN ({ids})" : " = {id}"
      return `EXISTS (SELECT 1 ${joins.join(" ")} WHERE ${aliases[0]!}.${quoteIdentifier(firstHop.toColumn)} = ${quoteRootRef(table.name, firstHop.toColumn)} AND ${lastAlias}.${quoteIdentifier(lastHop.fromColumn)}${op})`
    }
    default:
      throw new Error(`Unsupported scope kind for table ${String(table.name)}.`)
  }
}

function quoteIdentifier(identifier: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier) ? identifier : `[${identifier}]`
}

function quoteRootRef(tableName: string, column: string): string {
  return `${tableName}.${quoteIdentifier(column)}`
}
