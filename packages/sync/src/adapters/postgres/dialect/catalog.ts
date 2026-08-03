/**
 * Postgres catalog probes — information_schema + pg_catalog.
 */

function escapeLiteral(value: string): string {
  return value.replace(/'/g, "''")
}

function splitQualified(qualifiedTable: string): { schema: string; name: string } {
  const [schema, name] = qualifiedTable.split(".")
  if (!schema || !name) {
    throw new Error(`postgres catalog: expected schema.table, got ${qualifiedTable}`)
  }
  return { schema, name }
}

export function pgTargetColumnsSql(qualifiedTable: string): string {
  const { schema, name } = splitQualified(qualifiedTable)
  return `
    SELECT
      c.column_name AS name,
      CASE WHEN c.is_identity = 'YES' THEN 1 ELSE 0 END AS is_identity,
      CASE WHEN c.is_generated = 'ALWAYS' THEN 1 ELSE 0 END AS is_computed
    FROM information_schema.columns c
    WHERE c.table_schema = '${escapeLiteral(schema)}'
      AND c.table_name = '${escapeLiteral(name)}'
    ORDER BY c.ordinal_position
  `
}

export function pgPrimaryKeySql(qualifiedTable: string): string {
  const { schema, name } = splitQualified(qualifiedTable)
  return `
    SELECT kcu.column_name AS name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name
     AND kcu.table_schema = tc.table_schema
     AND kcu.table_name = tc.table_name
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema = '${escapeLiteral(schema)}'
      AND tc.table_name = '${escapeLiteral(name)}'
    ORDER BY kcu.ordinal_position
  `
}

export function pgHashColumnsMetaSql(qualifiedTable: string): string {
  const { schema, name } = splitQualified(qualifiedTable)
  return `
    SELECT
      c.column_name AS "columnName",
      CASE WHEN c.is_generated = 'ALWAYS' THEN true ELSE false END AS "isComputed",
      CASE WHEN c.is_identity = 'YES' THEN true ELSE false END AS "isIdentity",
      LOWER(c.data_type) AS "systemType"
    FROM information_schema.columns c
    WHERE c.table_schema = '${escapeLiteral(schema)}'
      AND c.table_name = '${escapeLiteral(name)}'
    ORDER BY c.ordinal_position
  `
}

export function pgInformationSchemaColumnsBySchemasSql(schemas: readonly string[]): string {
  const list = schemas.map((s) => `'${escapeLiteral(s)}'`).join(",")
  return `
    SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA IN (${list})
  `
}

export function pgInformationSchemaColumnsByTablesSql(tables: readonly string[]): string {
  const literals = tables
    .map((qn) => `'${escapeLiteral(qn.trim().toLowerCase())}'`)
    .join(", ")
  return `
    SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE LOWER(TABLE_SCHEMA || '.' || TABLE_NAME) IN (${literals})
  `
}

export function pgTableColumnNamesSql(qualifiedTable: string): string {
  const { schema, name } = splitQualified(qualifiedTable)
  return `
    SELECT c.column_name AS name
    FROM information_schema.columns c
    WHERE c.table_schema = '${escapeLiteral(schema)}'
      AND c.table_name = '${escapeLiteral(name)}'
    ORDER BY c.ordinal_position
  `
}

export function pgTableHasTriggersSql(qualifiedTable: string): string {
  const { schema, name } = splitQualified(qualifiedTable)
  return `
    SELECT COUNT(*)::int AS cnt
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = '${escapeLiteral(schema)}'
      AND c.relname = '${escapeLiteral(name)}'
      AND NOT t.tgisinternal
      AND t.tgenabled <> 'D'
  `
}

function pgForeignKeysSql(qualifiedTable: string, side: "inbound" | "outbound"): string {
  const { schema, name } = splitQualified(qualifiedTable)
  const sideFilter =
    side === "inbound"
      ? `ccu.table_schema = '${escapeLiteral(schema)}' AND ccu.table_name = '${escapeLiteral(name)}'`
      : `tc.table_schema = '${escapeLiteral(schema)}' AND tc.table_name = '${escapeLiteral(name)}'`
  return `
    SELECT
      tc.table_schema AS "fromSchema",
      tc.table_name AS "fromName",
      kcu.column_name AS "fromColumn",
      ccu.table_schema AS "toSchema",
      ccu.table_name AS "toName",
      ccu.column_name AS "toColumn",
      tc.constraint_name AS "constraintName",
      (
        SELECT COUNT(*)::int
        FROM information_schema.key_column_usage x
        WHERE x.constraint_name = tc.constraint_name
          AND x.table_schema = tc.table_schema
      ) AS "fkColumnCount"
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name
     AND kcu.table_schema = tc.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
     AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND ${sideFilter}
  `
}

export function pgInboundForeignKeysSql(qualifiedTable: string): string {
  return pgForeignKeysSql(qualifiedTable, "inbound")
}

export function pgOutboundForeignKeysSql(qualifiedTable: string): string {
  return pgForeignKeysSql(qualifiedTable, "outbound")
}

export function pgRootTableColumnsSql(schema: string, table: string): string {
  return `
    SELECT c.column_name AS name
    FROM information_schema.columns c
    WHERE c.table_schema = '${escapeLiteral(schema)}'
      AND c.table_name = '${escapeLiteral(table)}'
    ORDER BY c.ordinal_position
  `
}
