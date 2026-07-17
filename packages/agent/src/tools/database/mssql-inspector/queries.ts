// ── SQL queries ──────────────────────────────────────────────────

/** Get T-SQL source + object type for a named object. */
export const GET_DEFINITION = `
  SELECT
    s.name          AS schema_name,
    o.name          AS object_name,
    o.type_desc     AS object_type,
    sm.definition   AS definition,
    o.create_date,
    o.modify_date
  FROM sys.sql_modules sm
  JOIN sys.objects o  ON sm.object_id = o.object_id
  JOIN sys.schemas s  ON o.schema_id = s.schema_id
  WHERE s.name = @schema AND o.name = @object
`

/** Direct dependencies (one hop) of a named object. */
export const GET_DEPENDENCIES = `
  SELECT DISTINCT
    COALESCE(rs.name, d.referenced_schema_name)   AS ref_schema,
    COALESCE(ro.name, d.referenced_entity_name)   AS ref_name,
    COALESCE(ro.type_desc, 'UNKNOWN')             AS ref_type
  FROM sys.sql_expression_dependencies d
  LEFT JOIN sys.objects ro  ON d.referenced_id = ro.object_id
  LEFT JOIN sys.schemas rs  ON ro.schema_id = rs.schema_id
  WHERE d.referencing_id = OBJECT_ID(@qualifiedName)
    AND d.referenced_entity_name IS NOT NULL
  ORDER BY ref_schema, ref_name
`

/** All objects whose definition references a given table/pattern. */
export const SEARCH_DEFINITIONS = `
  SELECT
    s.name          AS schema_name,
    o.name          AS object_name,
    o.type_desc     AS object_type,
    o.modify_date
  FROM sys.sql_modules sm
  JOIN sys.objects o  ON sm.object_id = o.object_id
  JOIN sys.schemas s  ON o.schema_id = s.schema_id
  WHERE sm.definition LIKE @pattern
  ORDER BY s.name, o.type_desc, o.name
`

/** Missing index recommendations from SQL Server DMVs. */
export const MISSING_INDEXES = `
  SELECT TOP 20
    mid.statement                                                          AS table_name,
    mid.equality_columns,
    mid.inequality_columns,
    mid.included_columns,
    migs.unique_compiles,
    migs.user_seeks + migs.user_scans                                      AS total_hits,
    CAST(migs.avg_total_user_cost * migs.avg_user_impact
         * (migs.user_seeks + migs.user_scans) AS INT)                    AS improvement_score,
    CAST(migs.avg_user_impact AS INT)                                      AS est_pct_benefit
  FROM sys.dm_db_missing_index_details mid
  JOIN sys.dm_db_missing_index_groups mig
    ON mid.index_handle = mig.index_handle
  JOIN sys.dm_db_missing_index_group_stats migs
    ON mig.index_group_handle = migs.group_handle
  ORDER BY improvement_score DESC
`

/** Top expensive queries by avg CPU from query stats cache. */
export const SLOW_QUERIES = `
  SELECT TOP 15
    qs.execution_count,
    CAST(qs.total_worker_time   / qs.execution_count / 1000.0 AS INT) AS avg_cpu_ms,
    CAST(qs.total_elapsed_time  / qs.execution_count / 1000.0 AS INT) AS avg_elapsed_ms,
    CAST(qs.total_logical_reads / qs.execution_count AS INT)          AS avg_logical_reads,
    qs.total_logical_reads                                             AS total_logical_reads,
    SUBSTRING(
      qt.text,
      (qs.statement_start_offset / 2) + 1,
      (
        (CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(qt.text)
         ELSE qs.statement_end_offset END - qs.statement_start_offset) / 2
      ) + 1
    ) AS query_text,
    DB_NAME(qt.dbid) AS database_name
  FROM sys.dm_exec_query_stats qs
  CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) qt
  WHERE qt.text NOT LIKE '%dm_exec_query_stats%'
  ORDER BY avg_cpu_ms DESC
`

/**
 * Bulk fetch T-SQL definitions for many objects at once.
 *
 * Used by `scan_duplicates` to answer questions like
 *   "how many of these N datasets have duplicate joins?"
 * in a single round-trip instead of N invocations of inspect_definition.
 *
 * Filters:
 *   @schemaFilter — optional schema name (NULL = all schemas)
 *   @namesCsv     — optional comma-separated list of qualified names
 *                   (e.g. "core.vDataset,publish.Revenue") — NULL = all
 *   @objectTypes  — comma-separated type filter
 *                   (e.g. "VIEW,SQL_STORED_PROCEDURE,SQL_TABLE_VALUED_FUNCTION")
 */
export const BULK_DEFINITIONS = `
  ;WITH wanted AS (
    SELECT value AS qname
    FROM STRING_SPLIT(ISNULL(@namesCsv, ''), ',')
    WHERE LTRIM(RTRIM(value)) <> ''
  ),
  types AS (
    SELECT LTRIM(RTRIM(value)) AS t
    FROM STRING_SPLIT(@objectTypes, ',')
    WHERE LTRIM(RTRIM(value)) <> ''
  )
  SELECT
    s.name        AS schema_name,
    o.name        AS object_name,
    o.type_desc   AS object_type,
    sm.definition AS definition
  FROM sys.sql_modules sm
  JOIN sys.objects o ON sm.object_id = o.object_id
  JOIN sys.schemas s ON o.schema_id = s.schema_id
  WHERE (@schemaFilter IS NULL OR s.name = @schemaFilter)
    AND o.type_desc IN (SELECT t FROM types)
    AND (
      NOT EXISTS (SELECT 1 FROM wanted)
      OR (s.name + '.' + o.name) IN (SELECT qname FROM wanted)
    )
    AND sm.definition IS NOT NULL
`

/** Index usage stats for a specific table. */
export const INDEX_USAGE = `
  SELECT
    i.name                                                    AS index_name,
    i.type_desc                                               AS index_type,
    ius.user_seeks,
    ius.user_scans,
    ius.user_lookups,
    ius.user_updates,
    ius.last_user_seek,
    ius.last_user_scan,
    ius.last_user_update,
    STUFF(
      (SELECT ', ' + c.name
       FROM sys.index_columns ic2
       JOIN sys.columns c ON ic2.object_id = c.object_id AND ic2.column_id = c.column_id
       WHERE ic2.object_id = i.object_id AND ic2.index_id = i.index_id
         AND ic2.is_included_column = 0
       ORDER BY ic2.key_ordinal
       FOR XML PATH('')), 1, 2, ''
    ) AS key_columns
  FROM sys.indexes i
  LEFT JOIN sys.dm_db_index_usage_stats ius
    ON i.object_id = ius.object_id AND i.index_id = ius.index_id
    AND ius.database_id = DB_ID()
  WHERE i.object_id = OBJECT_ID(@qualifiedName)
    AND i.type > 0
  ORDER BY COALESCE(ius.user_seeks + ius.user_scans, 0) DESC
`
