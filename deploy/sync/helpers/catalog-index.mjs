/**
 * MSSQL catalog snapshot for entity derivation (table columns + FK edges).
 */

import { buildCatalogIndexFromQueryResults } from "./legacy-entity-derivation.mjs"

const CATALOG_SCHEMAS = ["core", "coreArchive", "gate", "gateArchive", "master"]
const SCHEMA_LIST = CATALOG_SCHEMAS.map((name) => `'${name}'`).join(",")

export async function loadCatalogIndexFromPool(pool) {
  const columns = await pool.request().query(`
    WITH pk_cols AS (
      SELECT ic.object_id, ic.column_id
      FROM sys.indexes i
      JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
      WHERE i.is_primary_key = 1
    )
    SELECT
      s.name AS schemaName,
      t.name AS tableName,
      c.name AS columnName,
      CASE WHEN pk_cols.column_id IS NULL THEN 0 ELSE 1 END AS isPrimaryKey
    FROM sys.columns c
    JOIN sys.tables t ON t.object_id = c.object_id
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    LEFT JOIN pk_cols ON pk_cols.object_id = c.object_id AND pk_cols.column_id = c.column_id
    WHERE s.name IN (${SCHEMA_LIST})
    ORDER BY s.name, t.name, c.column_id
  `)
  const foreignKeys = await pool.request().query(`
    SELECT
      rs.name AS parentSchema,
      rt.name AS parentTable,
      rc.name AS parentColumn,
      ps.name AS childSchema,
      pt.name AS childTable,
      pc.name AS childColumn
    FROM sys.foreign_key_columns fkc
    JOIN sys.tables pt ON pt.object_id = fkc.parent_object_id
    JOIN sys.schemas ps ON ps.schema_id = pt.schema_id
    JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
    JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
    JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
    JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
    WHERE ps.name IN (${SCHEMA_LIST})
      AND rs.name IN (${SCHEMA_LIST})
  `)
  return buildCatalogIndexFromQueryResults(columns.recordset, foreignKeys.recordset)
}
