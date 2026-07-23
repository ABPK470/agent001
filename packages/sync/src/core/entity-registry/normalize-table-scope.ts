/**
 * Table scope normalization — single runtime form: rootPk | sql.
 *
 * Legacy `fkPath` scopes compile to `sql` predicates on import/save.
 */

import type { EntityDefinition, EntityTable, EntityTableScope } from "../../domain/entity-registry/types.js"
import { renumberEntityTablesExecutionOrder } from "./order.js"

export interface FkPathHop {
  table: string
  fromColumn: string
  toColumn: string
}

function quoteIdentifier(identifier: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier) ? identifier : `[${identifier}]`
}

function quoteRootRef(tableName: string, column: string): string {
  return `${tableName}.${quoteIdentifier(column)}`
}

/** Compile a legacy fkPath hop list into the canonical SQL predicate. */
export function compileFkPathPredicate(
  entity: Pick<EntityDefinition, "selfJoinColumn">,
  tableName: string,
  through: readonly FkPathHop[],
): string {
  if (!through.length) {
    throw new Error(`Table ${tableName} has fkPath scope with no hops.`)
  }
  const hasSelfJoin = typeof entity.selfJoinColumn === "string" && entity.selfJoinColumn.trim().length > 0
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
        `JOIN ${hop.table} AS ${alias} ON ${alias}.${quoteIdentifier(hop.toColumn)} = ${previousAlias}.${quoteIdentifier(previousHop.fromColumn)}`,
      )
    }
  }
  const firstHop = through[0]!
  const lastHop = through[through.length - 1]!
  const lastAlias = aliases[aliases.length - 1]!
  const op = hasSelfJoin ? " IN ({ids})" : " = {id}"
  return `EXISTS (SELECT 1 ${joins.join(" ")} WHERE ${aliases[0]!}.${quoteIdentifier(firstHop.toColumn)} = ${quoteRootRef(tableName, firstHop.toColumn)} AND ${lastAlias}.${quoteIdentifier(lastHop.fromColumn)}${op})`
}

export function normalizeTableScope(
  entity: Pick<EntityDefinition, "selfJoinColumn">,
  table: Pick<EntityTable, "name" | "scope">,
): EntityTableScope {
  if (table.scope.kind !== "fkPath") return table.scope
  return {
    kind: "sql",
    predicate: compileFkPathPredicate(entity, table.name, table.scope.through),
  }
}

export function normalizeEntityDefinition<T extends EntityDefinition>(def: T): T {
  return {
    ...def,
    tables: renumberEntityTablesExecutionOrder(
      def.tables.map((table) => ({
        ...table,
        scope: normalizeTableScope(def, table),
      })),
    ),
  }
}
