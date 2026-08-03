/**
 * Catalog probes — columns, PK, FKs, triggers, INFORMATION_SCHEMA (sys.*).
 * SQL text matches prior runtime paths (zero behavior change).
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

export function mssqlHashColumnsMetaSql(qualifiedTable: string): string {
  const [schema, name] = qualifiedTable.split(".")
  if (!schema || !name) {
    throw new Error(`mssqlHashColumnsMetaSql: expected schema.table, got ${qualifiedTable}`)
  }
  return `
    SELECT
      c.name             AS columnName,
      c.is_computed      AS isComputed,
      c.is_identity      AS isIdentity,
      LOWER(ty.name)     AS systemType
    FROM sys.columns c
    JOIN sys.objects o  ON o.object_id = c.object_id
    JOIN sys.types ty   ON ty.user_type_id = c.user_type_id
    WHERE o.[type] = 'U'
      AND o.name = '${escapeLiteral(name)}'
      AND OBJECT_SCHEMA_NAME(c.object_id) = '${escapeLiteral(schema)}'
    ORDER BY c.column_id
  `
}

export function mssqlInformationSchemaColumnsBySchemasSql(schemas: readonly string[]): string {
  const list = schemas.map((s) => `'${escapeLiteral(s)}'`).join(",")
  return `
    SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA IN (${list})
  `
}

export function mssqlInformationSchemaColumnsByTablesSql(tables: readonly string[]): string {
  const literals = tables
    .map((qn) => {
      const normalized = qn.trim().toLowerCase()
      return `N'${escapeLiteral(normalized)}'`
    })
    .join(", ")
  return `
    SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE LOWER(TABLE_SCHEMA + '.' + TABLE_NAME) IN (${literals})
  `
}

export function mssqlTableColumnNamesSql(qualifiedTable: string): string {
  const [schema, name] = qualifiedTable.split(".")
  if (!schema || !name) {
    throw new Error(`mssqlTableColumnNamesSql: expected schema.table, got ${qualifiedTable}`)
  }
  return `
      SELECT c.name
      FROM sys.columns c
      WHERE c.object_id = OBJECT_ID('${escapeLiteral(schema)}.${escapeLiteral(name)}')
      ORDER BY c.column_id
    `
}

export function mssqlTableHasTriggersSql(qualifiedTable: string): string {
  const [schema, name] = qualifiedTable.split(".")
  if (!schema || !name) {
    throw new Error(`mssqlTableHasTriggersSql: expected schema.table, got ${qualifiedTable}`)
  }
  return `
      SELECT COUNT(*) AS cnt
      FROM sys.triggers t
      JOIN sys.objects o ON o.object_id = t.parent_id
      JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE s.name = '${escapeLiteral(schema)}' AND o.name = '${escapeLiteral(name)}' AND t.is_disabled = 0
    `
}

function mssqlForeignKeysSql(qualifiedTable: string, side: "inbound" | "outbound"): string {
  const objectIdLiteral = escapeLiteral(qualifiedTable)
  const where =
    side === "inbound"
      ? `fk.referenced_object_id = OBJECT_ID(N'${objectIdLiteral}')`
      : `fk.parent_object_id = OBJECT_ID(N'${objectIdLiteral}')`
  return `
    SELECT
      OBJECT_SCHEMA_NAME(fk.parent_object_id) AS fromSchema,
      OBJECT_NAME(fk.parent_object_id) AS fromName,
      COL_NAME(fc.parent_object_id, fc.parent_column_id) AS fromColumn,
      OBJECT_SCHEMA_NAME(fk.referenced_object_id) AS toSchema,
      OBJECT_NAME(fk.referenced_object_id) AS toName,
      COL_NAME(fc.referenced_object_id, fc.referenced_column_id) AS toColumn,
      fk.name AS constraintName,
      (
        SELECT COUNT(*) FROM sys.foreign_key_columns x
        WHERE x.constraint_object_id = fk.object_id
      ) AS fkColumnCount
    FROM sys.foreign_keys fk
    INNER JOIN sys.foreign_key_columns fc ON fc.constraint_object_id = fk.object_id
    WHERE ${where}
    `
}

export function mssqlInboundForeignKeysSql(qualifiedTable: string): string {
  return mssqlForeignKeysSql(qualifiedTable, "inbound")
}

export function mssqlOutboundForeignKeysSql(qualifiedTable: string): string {
  return mssqlForeignKeysSql(qualifiedTable, "outbound")
}

export function mssqlRootTableColumnsSql(schema: string, table: string): string {
  return `
      SELECT c.name
      FROM sys.columns c
      INNER JOIN sys.objects o ON o.object_id = c.object_id
      INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE s.name = N'${escapeLiteral(schema)}'
        AND o.name = N'${escapeLiteral(table)}'
        AND o.type IN ('U', 'V')
      ORDER BY c.column_id
    `
}
