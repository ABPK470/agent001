// ── SQL introspection queries ────────────────────────────────────

export const Q_OBJECTS = `
  SELECT
    s.name       AS schema_name,
    o.name       AS object_name,
    o.type_desc  AS object_type,
    CASE WHEN o.type = 'U' THEN (
      SELECT SUM(p.rows) FROM sys.partitions p
      WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)
    ) ELSE NULL END AS row_count
  FROM sys.objects o
  JOIN sys.schemas s ON o.schema_id = s.schema_id
  WHERE o.type IN ('U', 'V')
    AND o.is_ms_shipped = 0
  ORDER BY s.name, o.name
`

export const Q_COLUMNS = `
  ;WITH pk_cols AS (
    SELECT ic.object_id, ic.column_id
    FROM sys.index_columns ic
    JOIN sys.indexes i ON ic.object_id = i.object_id AND ic.index_id = i.index_id
    WHERE i.is_primary_key = 1
  )
  SELECT
    s.name       AS schema_name,
    t.name       AS table_name,
    c.name       AS column_name,
    ty.name      AS data_type,
    c.max_length,
    c.is_nullable,
    CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS is_pk
  FROM sys.columns c
  JOIN sys.objects t  ON c.object_id = t.object_id
  JOIN sys.schemas s  ON t.schema_id = s.schema_id
  JOIN sys.types ty   ON c.user_type_id = ty.user_type_id
  LEFT JOIN pk_cols pk ON c.object_id = pk.object_id AND c.column_id = pk.column_id
  WHERE t.type IN ('U', 'V')
    AND t.is_ms_shipped = 0
  ORDER BY s.name, t.name, c.column_id
`

export const Q_FKS = `
  SELECT
    fk.name  AS constraint_name,
    ps.name  AS from_schema,
    pt.name  AS from_table,
    pc.name  AS from_column,
    rs.name  AS to_schema,
    rt.name  AS to_table,
    rc.name  AS to_column
  FROM sys.foreign_keys fk
  JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
  JOIN sys.tables pt  ON fkc.parent_object_id     = pt.object_id
  JOIN sys.schemas ps ON pt.schema_id              = ps.schema_id
  JOIN sys.columns pc ON fkc.parent_object_id      = pc.object_id AND fkc.parent_column_id     = pc.column_id
  JOIN sys.tables rt  ON fkc.referenced_object_id  = rt.object_id
  JOIN sys.schemas rs ON rt.schema_id              = rs.schema_id
  JOIN sys.columns rc ON fkc.referenced_object_id  = rc.object_id AND fkc.referenced_column_id = rc.column_id
  ORDER BY fk.name, fkc.constraint_column_id
`

/**
 * All columns for all sys.* schema objects (catalog views + DMVs + TVFs).
 * Fetched at catalog build time so the agent knows what columns each sys object has.
 * We fetch ALL sys objects and filter locally to those in SYS_DESCRIPTORS, avoiding
 * a large IN clause. Runs once at startup — ~4000 rows, fast.
 */
export const Q_SYS_COLUMNS = `
  SELECT
    o.name       AS object_name,
    c.name       AS column_name,
    ty.name      AS data_type
  FROM sys.all_columns c
  JOIN sys.all_objects o  ON c.object_id  = o.object_id
  JOIN sys.schemas s      ON o.schema_id  = s.schema_id
  JOIN sys.types ty       ON c.user_type_id = ty.user_type_id
  WHERE s.name = 'sys'
  ORDER BY o.name, c.column_id
`

/**
 * View → source table dependencies.
 * Used at catalog build time to compute per-view "underlying source rows" by summing
 * the row counts of each physical table a view directly or indirectly references.
 * sys.sql_expression_dependencies is catalog metadata — this runs in milliseconds.
 * referenced_class = 1 filters to OBJECT_OR_COLUMN references (physical tables/views).
 * We only follow one level: view → the tables/views it directly FROM/JOINs.
 */
export const Q_VIEW_DEPS = `
  SELECT
    vs.name  AS view_schema,
    v.name   AS view_name,
    rs.name  AS ref_schema,
    rt.name  AS ref_name
  FROM sys.sql_expression_dependencies d
  JOIN sys.objects v  ON d.referencing_id = v.object_id  AND v.type  = 'V'
  JOIN sys.schemas vs ON v.schema_id       = vs.schema_id
  JOIN sys.objects rt ON d.referenced_id   = rt.object_id AND rt.type = 'U'
  JOIN sys.schemas rs ON rt.schema_id      = rs.schema_id
  WHERE d.referenced_class = 1
    AND rt.is_ms_shipped   = 0
`
