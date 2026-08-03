/**
 * Catalog probes — columns + PK (sys.*).
 * SQL text matches prior runtime/apply.ts / columns paths (zero behavior change).
 */

function escapeLiteral(value: string): string {
  return value.replace(/'/g, "''")
}

export function mssqlTargetColumnsSql(qualifiedTable: string): string {
  return `
    SELECT c.name, c.is_identity, c.is_computed
    FROM sys.columns c
    WHERE c.object_id = OBJECT_ID('${escapeLiteral(qualifiedTable)}')
    ORDER BY c.column_id
  `
}

export function mssqlPrimaryKeySql(qualifiedTable: string): string {
  const [schema, name] = qualifiedTable.split(".")
  if (!schema || !name) {
    throw new Error(`mssqlPrimaryKeySql: expected schema.table, got ${qualifiedTable}`)
  }
  return `
        SELECT c.name
        FROM sys.indexes i
        JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        JOIN sys.columns c        ON c.object_id  = ic.object_id AND c.column_id = ic.column_id
        WHERE i.is_primary_key = 1
          AND i.object_id = OBJECT_ID('${escapeLiteral(schema)}.${escapeLiteral(name)}')
        ORDER BY ic.key_ordinal
      `
}
