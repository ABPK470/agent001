/**
 * Curated descriptions and semantic keyword aliases for SQL Server sys.* objects.
 *
 * WHY THIS EXISTS:
 * The schema catalog only covers user objects (WHERE is_ms_shipped = 0). SQL Server's
 * sys.* catalog — 400+ DMVs, catalog views, and TVFs — is completely invisible to it.
 * This causes the agent to return "No matches" for questions about tombstone row groups,
 * index fragmentation, query performance, locking, memory pressure, etc.
 *
 * HOW IT WORKS:
 * At catalog build time, we fetch live column definitions for all sys.* objects from the
 * database. We then overlay these curated entries (description + aliases) so that
 * search_catalog("tombstone") finds sys.dm_db_column_store_row_group_physical_stats via
 * its "tombstone" alias, even though that word doesn't appear in the object name.
 *
 * LIVE COLUMNS + CURATED SEMANTICS:
 * Columns come from the DB (always accurate for the SQL Server version). Descriptions,
 * aliases, and example queries are curated here in code (source of truth for semantics).
 */

export interface SysDescriptor {
  /** Human-readable explanation of what this sys object does. */
  description: string
  /**
   * Semantic keyword aliases — words that users might search for that semantically
   * relate to this sys object, even if those words don't appear in the object name
   * or column names. e.g. "tombstone" → dm_db_column_store_row_group_physical_stats.
   */
  aliases: string[]
  /** Ready-to-paste example query. Omit if trivial. */
  exampleQuery?: string
}

/**
 * Curated map: sys object name (without schema) → descriptor.
 * Keys are lowercase. Covers the ~50 most important sys objects for DWH/analytics work.
 */
export const SYS_DESCRIPTORS = new Map<string, SysDescriptor>([

  // ── Columnstore internals ──────────────────────────────────────────────────────────

  ["dm_db_column_store_row_group_physical_stats", {
    description:
      "Columnstore index row group physical state and storage info per row group. " +
      "state_desc values: " +
      "OPEN = delta store, accepting inserts, not yet compressed; " +
      "CLOSED = delta store full, waiting for tuple mover to compress; " +
      "COMPRESSED = normal active compressed row group (healthy); " +
      "TOMBSTONE = ALL rows in this row group were deleted — row group is pending garbage collection by the tuple mover (wasted space); " +
      "BULK_IMPORT_LOADING = being loaded via bulk insert. " +
      "High TOMBSTONE row group counts mean the columnstore index is bloated and needs ALTER INDEX ... REORGANIZE. " +
      "total_rows = rows ever written; deleted_rows tracks the delete bitmap.",
    aliases: [
      "tombstone", "tombstones", "tombstone rows", "tombstone row group",
      "columnstore", "column store", "column store index", "columnstore index",
      "csrg", "row group", "row groups", "delta store",
      "garbage collection", "tuple mover", "reclaim", "bloat",
      "compressed segment", "deleted rows", "state_desc",
    ],
    exampleQuery:
      "SELECT OBJECT_SCHEMA_NAME(s.object_id) AS schema_name, OBJECT_NAME(s.object_id) AS table_name, " +
      "i.name AS index_name, COUNT(*) AS tombstone_row_groups, SUM(s.total_rows) AS tombstone_rows, " +
      "SUM(s.size_in_bytes)/1024/1024 AS wasted_mb " +
      "FROM sys.dm_db_column_store_row_group_physical_stats s " +
      "JOIN sys.indexes i ON i.object_id = s.object_id AND i.index_id = s.index_id " +
      "WHERE s.state_desc = 'TOMBSTONE' " +
      "GROUP BY s.object_id, i.name ORDER BY tombstone_rows DESC",
  }],

  ["column_store_row_groups", {
    description:
      "Catalog view of columnstore row group metadata (lighter than the DMV). " +
      "One row per row group. Shows state, row_count, deleted_rows, and trim_reason for each compressed segment. " +
      "state: 1=OPEN, 2=CLOSED, 3=COMPRESSED, 4=TOMBSTONE. " +
      "trim_reason indicates why a row group was closed before reaching 1M rows.",
    aliases: [
      "columnstore", "column store", "row group", "row groups", "csrg",
      "tombstone", "compressed", "deleted rows", "trim reason",
    ],
    exampleQuery:
      "SELECT OBJECT_SCHEMA_NAME(object_id) AS schema_name, OBJECT_NAME(object_id) AS table_name, " +
      "state_desc, COUNT(*) AS groups, SUM(row_count) AS rows, SUM(deleted_rows) AS deleted " +
      "FROM sys.column_store_row_groups " +
      "GROUP BY object_id, state_desc ORDER BY schema_name, table_name, state_desc",
  }],

  ["column_store_segments", {
    description:
      "Columnstore segment metadata — one row per column per compressed row group. " +
      "Shows encoding_type (dictionary, delta, or value-based), min_data_id, max_data_id, and dictionary IDs. " +
      "Useful for understanding storage layout and diagnosing encoding inefficiencies.",
    aliases: [
      "columnstore", "column store", "segment", "segments", "compressed",
      "encoding", "dictionary", "min_data_id", "max_data_id",
    ],
  }],

  // ── Query performance DMVs ─────────────────────────────────────────────────────────

  ["dm_exec_query_stats", {
    description:
      "Cached query execution statistics — one row per cached query plan. " +
      "Tracks total_worker_time (CPU), total_elapsed_time, total_logical_reads, execution_count " +
      "accumulated since the plan was compiled (resets on plan eviction or restart). " +
      "Divide totals by execution_count for per-execution averages. " +
      "Must CROSS APPLY sys.dm_exec_sql_text(sql_handle) to get the query text.",
    aliases: [
      "slow query", "slow queries", "expensive query", "expensive queries",
      "top cpu", "query stats", "execution count", "total cpu", "avg cpu",
      "query performance", "logical reads", "elapsed time", "query plan stats",
    ],
    exampleQuery:
      "SELECT TOP 15 qs.execution_count, " +
      "CAST(qs.total_worker_time/qs.execution_count/1000.0 AS INT) AS avg_cpu_ms, " +
      "CAST(qs.total_elapsed_time/qs.execution_count/1000.0 AS INT) AS avg_elapsed_ms, " +
      "CAST(qs.total_logical_reads/qs.execution_count AS INT) AS avg_reads, " +
      "SUBSTRING(qt.text,(qs.statement_start_offset/2)+1,200) AS query_text " +
      "FROM sys.dm_exec_query_stats qs " +
      "CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) qt " +
      "WHERE qt.text NOT LIKE '%dm_exec_query_stats%' ORDER BY avg_cpu_ms DESC",
  }],

  ["dm_exec_sql_text", {
    description:
      "Table-valued function — returns SQL text for a given sql_handle or plan_handle. " +
      "Always CROSS APPLY this onto sys.dm_exec_query_stats or sys.dm_exec_requests. " +
      "The text column contains the full T-SQL batch; use statement_start_offset/end_offset to extract just the statement.",
    aliases: [
      "sql text", "query text", "plan handle", "sql handle",
      "query source", "get query", "get sql",
    ],
  }],

  ["dm_exec_cached_plans", {
    description:
      "Query plan cache — one row per cached execution plan. " +
      "Shows objtype (Adhoc/Prepared/Proc/View), usecounts (number of times reused), size_in_bytes. " +
      "High adhoc plan count with low usecounts suggests 'optimize for ad hoc workloads' should be enabled.",
    aliases: [
      "plan cache", "query plan", "cached plan", "plan reuse",
      "adhoc plan", "ad hoc", "plan bloat",
    ],
  }],

  ["dm_exec_requests", {
    description:
      "Currently executing requests — one row per in-flight query RIGHT NOW. " +
      "Shows session_id, status (running/suspended/sleeping), wait_type, wait_time, cpu_time, logical_reads, command. " +
      "CROSS APPLY sys.dm_exec_sql_text for the query text. " +
      "blocking_session_id > 0 means this request is blocked by another session.",
    aliases: [
      "running query", "running queries", "active query", "active queries",
      "current execution", "in-flight", "executing", "currently running",
      "live query", "active request",
    ],
    exampleQuery:
      "SELECT r.session_id, r.status, r.wait_type, r.wait_time, r.cpu_time, r.logical_reads, " +
      "r.blocking_session_id, SUBSTRING(st.text,(r.statement_start_offset/2)+1,100) AS query " +
      "FROM sys.dm_exec_requests r " +
      "CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) st " +
      "WHERE r.session_id > 50 ORDER BY r.cpu_time DESC",
  }],

  ["dm_exec_sessions", {
    description:
      "All active sessions — one row per connected session. " +
      "is_user_process=1 for application sessions (filter out system sessions). " +
      "Shows login_name, host_name, status (running/sleeping), cpu_time, logical_reads, last_request_start_time.",
    aliases: [
      "session", "sessions", "connection", "connections",
      "active connection", "login", "user session", "connected user",
    ],
    exampleQuery:
      "SELECT session_id, login_name, host_name, status, cpu_time, logical_reads, last_request_start_time " +
      "FROM sys.dm_exec_sessions WHERE is_user_process = 1 ORDER BY cpu_time DESC",
  }],

  // ── Wait statistics ────────────────────────────────────────────────────────────────

  ["dm_os_wait_stats", {
    description:
      "Accumulated wait statistics per wait type since SQL Server last restarted. " +
      "Identifies performance bottlenecks: what SQL Server is waiting for most. " +
      "Key wait types: CXPACKET = parallelism; PAGEIOLATCH_* = disk I/O; LCK_* = row/page locking; " +
      "WRITELOG = transaction log flush; SOS_SCHEDULER_YIELD = CPU pressure; " +
      "ASYNC_NETWORK_IO = client consuming results slowly. " +
      "Filter out benign idle waits before analyzing.",
    aliases: [
      "wait stats", "wait type", "bottleneck", "latency", "blocking", "io wait",
      "cpu wait", "parallelism", "latch", "cxpacket", "pageiolatch",
      "performance bottleneck", "wait analysis",
    ],
    exampleQuery:
      "SELECT TOP 20 wait_type, wait_time_ms/1000.0 AS wait_s, " +
      "(wait_time_ms - signal_wait_time_ms)/1000.0 AS resource_s, waiting_tasks_count " +
      "FROM sys.dm_os_wait_stats " +
      "WHERE wait_type NOT IN ('SLEEP_TASK','LAZYWRITER_SLEEP','BROKER_TO_FLUSH'," +
      "'BROKER_TASK_STOP','CLR_AUTO_EVENT','DISPATCHER_QUEUE_SEMAPHORE'," +
      "'ONDEMAND_TASK_QUEUE','REQUEST_FOR_DEADLOCK_SEARCH','RESOURCE_MONITORING'," +
      "'SERVER_IDLE_CHECK','SLEEP_DBSTARTUP','SLEEP_MASTERDBREADY','SQLTRACE_BUFFER_FLUSH'," +
      "'WAITFOR','XE_DISPATCHER_WAIT','XE_TIMER_EVENT','HADR_WORK_QUEUE'," +
      "'HADR_FILESTREAM_IOMGR_IOCOMPLETION','SLEEP_SYSTEMTASK','SNI_HTTP_ACCEPT') " +
      "ORDER BY wait_time_ms DESC",
  }],

  ["dm_os_waiting_tasks", {
    description:
      "Currently waiting tasks — live snapshot (unlike dm_os_wait_stats which is cumulative). " +
      "One row per active wait happening right now. " +
      "blocking_session_id shows who is causing the wait. " +
      "Useful for diagnosing active blocking chains, deadlock precursors.",
    aliases: [
      "waiting task", "active wait", "live wait",
      "current blocking", "blocking", "blocked query", "blocked session",
    ],
    exampleQuery:
      "SELECT wt.session_id, wt.wait_type, wt.wait_duration_ms, wt.blocking_session_id " +
      "FROM sys.dm_os_waiting_tasks wt WHERE wt.session_id > 50 ORDER BY wt.wait_duration_ms DESC",
  }],

  // ── Index DMVs ────────────────────────────────────────────────────────────────────

  ["dm_db_index_physical_stats", {
    description:
      "Index fragmentation and page density — table-valued function. " +
      "avg_fragmentation_in_percent > 30 → REBUILD recommended; 10–30 → REORGANIZE. " +
      "Parameters: DB_ID(), object_id (NULL=all), index_id (NULL=all), partition_number (NULL=all), " +
      "mode: 'LIMITED' (fastest, page count only), 'SAMPLED' (fragmentation estimated), 'DETAILED' (full scan). " +
      "page_count < 1000 → fragmentation doesn't matter much.",
    aliases: [
      "fragmentation", "index fragmentation", "rebuild", "reorganize",
      "page density", "fill factor", "defrag", "index health",
    ],
    exampleQuery:
      "SELECT OBJECT_SCHEMA_NAME(s.object_id) AS schema_name, OBJECT_NAME(s.object_id) AS table_name, " +
      "i.name AS index_name, s.index_type_desc, s.avg_fragmentation_in_percent, s.page_count " +
      "FROM sys.dm_db_index_physical_stats(DB_ID(),NULL,NULL,NULL,'SAMPLED') s " +
      "JOIN sys.indexes i ON s.object_id = i.object_id AND s.index_id = i.index_id " +
      "WHERE s.avg_fragmentation_in_percent > 10 AND s.page_count > 100 " +
      "ORDER BY s.avg_fragmentation_in_percent DESC",
  }],

  ["dm_db_index_usage_stats", {
    description:
      "Index usage counters since last SQL Server restart — seeks, scans, lookups, updates per index. " +
      "Indexes with high user_updates but zero seeks/scans are pure write overhead (candidates for removal). " +
      "Resets on service restart. Filter by database_id = DB_ID() for the current database.",
    aliases: [
      "index usage", "index seeks", "index scans", "unused index",
      "seek", "scan", "lookup", "index overhead", "index efficiency",
    ],
    exampleQuery:
      "SELECT OBJECT_SCHEMA_NAME(i.object_id) AS schema_name, OBJECT_NAME(i.object_id) AS table_name, " +
      "i.name AS index_name, ius.user_seeks, ius.user_scans, ius.user_lookups, ius.user_updates " +
      "FROM sys.indexes i " +
      "LEFT JOIN sys.dm_db_index_usage_stats ius " +
      "  ON i.object_id = ius.object_id AND i.index_id = ius.index_id AND ius.database_id = DB_ID() " +
      "WHERE i.object_id > 100 AND i.index_id > 0 " +
      "ORDER BY COALESCE(ius.user_seeks+ius.user_scans,0) ASC, ius.user_updates DESC",
  }],

  ["dm_db_missing_index_details", {
    description:
      "SQL Server's missing index recommendations — detected by the query optimizer when it estimates " +
      "a missing index would significantly reduce query cost. " +
      "Join with sys.dm_db_missing_index_groups and sys.dm_db_missing_index_group_stats for the impact score.",
    aliases: [
      "missing index", "recommended index", "index recommendation",
      "create index", "index suggestion", "index advice",
    ],
    exampleQuery:
      "SELECT mid.statement AS table_name, mid.equality_columns, mid.inequality_columns, mid.included_columns, " +
      "CAST(migs.avg_total_user_cost * migs.avg_user_impact * (migs.user_seeks + migs.user_scans) AS INT) AS improvement_score " +
      "FROM sys.dm_db_missing_index_details mid " +
      "JOIN sys.dm_db_missing_index_groups mig ON mid.index_handle = mig.index_handle " +
      "JOIN sys.dm_db_missing_index_group_stats migs ON mig.index_group_handle = migs.group_handle " +
      "ORDER BY improvement_score DESC",
  }],

  ["indexes", {
    description:
      "All index definitions — one row per index per table. " +
      "index_id=0 = heap (no clustered index and no rows stored in index order); " +
      "index_id=1 = clustered index (data physically ordered); index_id>1 = nonclustered. " +
      "type_desc: HEAP, CLUSTERED, NONCLUSTERED, XML, SPATIAL, CLUSTERED COLUMNSTORE, NONCLUSTERED COLUMNSTORE.",
    aliases: [
      "index definition", "clustered index", "nonclustered index",
      "columnstore index", "unique index", "heap", "primary key index",
      "index list", "index type", "all indexes",
    ],
    exampleQuery:
      "SELECT OBJECT_SCHEMA_NAME(i.object_id) AS schema_name, OBJECT_NAME(i.object_id) AS table_name, " +
      "i.name AS index_name, i.type_desc, i.is_unique, i.is_primary_key, i.is_disabled " +
      "FROM sys.indexes i WHERE i.object_id > 100 ORDER BY schema_name, table_name, i.index_id",
  }],

  ["index_columns", {
    description:
      "Columns that make up each index — one row per column per index. " +
      "is_included_column=1 = INCLUDE column (not in key, carried for covering). " +
      "key_ordinal gives position in the key (0 for included columns). " +
      "index_column_id is position in the index regardless of key/include.",
    aliases: [
      "index key", "index key columns", "included columns",
      "index column", "composite index", "covering index",
    ],
  }],

  // ── Object metadata catalog views ──────────────────────────────────────────────────

  ["all_objects", {
    description:
      "All objects in the database — user AND system objects. " +
      "type: U=USER_TABLE, V=VIEW, P=STORED_PROCEDURE, FN=SCALAR_FUNCTION, IF=INLINE_TABLE_FUNCTION, " +
      "TF=TABLE_FUNCTION, TR=TRIGGER, SO=SEQUENCE_OBJECT, SN=SYNONYM. " +
      "is_ms_shipped=1 for system objects. Filter with is_ms_shipped=0 for user objects only.",
    aliases: [
      "all objects", "object list", "object type", "system objects", "user objects",
    ],
  }],

  ["objects", {
    description:
      "User database objects only (is_ms_shipped=0). " +
      "type: U=USER_TABLE, V=VIEW, P=STORED_PROCEDURE, FN=FUNCTION, TR=TRIGGER. " +
      "Use this in preference to sys.all_objects when you only want user-defined objects.",
    aliases: [
      "object list", "all objects", "table list", "view list",
      "object metadata", "object type", "stored procedures", "functions",
    ],
  }],

  ["tables", {
    description:
      "All user tables (equivalent to sys.objects WHERE type='U'). " +
      "Faster than filtering sys.objects when you specifically need tables. " +
      "Join with sys.schemas for schema name.",
    aliases: ["table list", "user tables", "regular tables", "all tables"],
  }],

  ["views", {
    description:
      "All view definitions. Join with sys.sql_modules for the T-SQL definition. " +
      "is_replicated, has_opaque_metadata, with_check_option are useful for view analysis.",
    aliases: ["view list", "view definition", "all views", "view catalog"],
  }],

  ["columns", {
    description:
      "All columns for all user tables and views. " +
      "column_id gives ordinal position. " +
      "Join with sys.types for data_type info. is_nullable, is_identity, is_computed are key flags.",
    aliases: [
      "column list", "all columns", "column definition",
      "column metadata", "table columns",
    ],
  }],

  ["all_columns", {
    description:
      "All columns for ALL objects, including system objects (sys.* views, DMVs, TVFs). " +
      "Use to discover columns of sys.* objects themselves. " +
      "Filter by schema_id to scope to specific schemas.",
    aliases: [
      "sys columns", "system columns", "all columns",
      "dmv columns", "sys object columns",
    ],
  }],

  ["schemas", {
    description:
      "All database schemas. schema_id links to sys.objects. " +
      "principal_id is the schema owner (link to sys.database_principals).",
    aliases: ["schema list", "database schemas", "all schemas", "schema names"],
  }],

  ["types", {
    description:
      "All data types — system types and user-defined types. " +
      "user_type_id matches sys.columns.user_type_id for column type lookups. " +
      "system_type_id identifies the base SQL Server type.",
    aliases: ["data type", "data types", "user type", "column type", "type list"],
  }],

  // ── T-SQL definitions ──────────────────────────────────────────────────────────────

  ["sql_modules", {
    description:
      "T-SQL source code for all programmable objects — views, stored procedures, " +
      "scalar functions, table-valued functions, triggers. " +
      "definition column contains the full CREATE statement. " +
      "Uses_ansi_nulls, uses_quoted_identifier are schema-sensitivity flags.",
    aliases: [
      "T-SQL source", "object definition", "view source", "stored procedure definition",
      "function definition", "object source code", "view code", "proc code",
    ],
    exampleQuery:
      "SELECT OBJECT_SCHEMA_NAME(object_id) AS schema_name, " +
      "OBJECT_NAME(object_id) AS object_name, definition " +
      "FROM sys.sql_modules WHERE OBJECT_NAME(object_id) = 'YourViewName'",
  }],

  // ── Dependencies ───────────────────────────────────────────────────────────────────

  ["sql_expression_dependencies", {
    description:
      "Object-to-object static dependencies — what each view/proc/function references. " +
      "referencing_id → the dependent object. referenced_id / referenced_entity_name → what it depends on. " +
      "referenced_class=1 = OBJECT_OR_COLUMN (table/view reference). " +
      "Use to find everything a view depends on, or everything that depends on a given table.",
    aliases: [
      "dependency", "dependencies", "object dependency", "view dependency",
      "what references", "what depends on", "references", "referencing",
      "depends on", "dependency tree",
    ],
    exampleQuery:
      "SELECT OBJECT_SCHEMA_NAME(referencing_id) AS from_schema, " +
      "OBJECT_NAME(referencing_id) AS from_object, " +
      "referenced_schema_name AS to_schema, referenced_entity_name AS to_object " +
      "FROM sys.sql_expression_dependencies " +
      "WHERE referencing_id = OBJECT_ID('publish.Revenue') ORDER BY to_schema, to_object",
  }],

  // ── Partitioning ───────────────────────────────────────────────────────────────────

  ["partitions", {
    description:
      "Partition metadata — one row per index per partition. " +
      "rows = row count for this partition (accurate for heap/clustered). " +
      "data_compression_desc: NONE / ROW / PAGE / COLUMNSTORE / COLUMNSTORE_ARCHIVE. " +
      "index_id=0 = heap, index_id=1 = clustered index (rows here = table row count).",
    aliases: [
      "partition", "partitions", "row count", "table rows",
      "partition count", "data compression", "table size",
    ],
    exampleQuery:
      "SELECT OBJECT_SCHEMA_NAME(p.object_id) AS schema_name, OBJECT_NAME(p.object_id) AS table_name, " +
      "SUM(p.rows) AS total_rows, p.data_compression_desc " +
      "FROM sys.partitions p WHERE p.index_id IN (0,1) AND p.object_id > 100 " +
      "GROUP BY p.object_id, p.data_compression_desc ORDER BY total_rows DESC",
  }],

  ["dm_db_partition_stats", {
    description:
      "Partition statistics with row counts and page counts — more current than sys.partitions for active tables. " +
      "row_count is refreshed more frequently. " +
      "reserved_page_count and used_page_count give storage: multiply by 8KB for bytes.",
    aliases: [
      "partition stats", "table size", "row count", "page count",
      "table rows", "storage size", "used pages", "data size",
    ],
    exampleQuery:
      "SELECT OBJECT_SCHEMA_NAME(object_id) AS schema_name, OBJECT_NAME(object_id) AS table_name, " +
      "SUM(row_count) AS total_rows, SUM(used_page_count)*8/1024 AS size_mb " +
      "FROM sys.dm_db_partition_stats WHERE index_id IN (0,1) " +
      "GROUP BY object_id ORDER BY total_rows DESC",
  }],

  ["partition_functions", {
    description:
      "Partition function definitions — defines how rows are divided across partitions by a column range. " +
      "boundary_value_on_right=1 means the boundary value belongs to the RIGHT (higher) partition.",
    aliases: [
      "partition function", "partition range", "partition boundary",
      "table partitioning", "range partition",
    ],
  }],

  ["partition_schemes", {
    description:
      "Maps a partition function to filegroups. " +
      "Every partitioned table references a partition scheme which in turn references a partition function.",
    aliases: ["partition scheme", "filegroup", "partitioned table", "partition layout"],
  }],

  // ── Foreign keys and constraints ───────────────────────────────────────────────────

  ["foreign_keys", {
    description:
      "All foreign key constraints. " +
      "parent_object_id = the table with the FK column; referenced_object_id = the table being referenced. " +
      "delete_referential_action_desc / update_referential_action_desc: NO_ACTION, CASCADE, SET_NULL, SET_DEFAULT.",
    aliases: [
      "foreign key", "FK", "referential integrity", "constraint",
      "FK constraint", "all foreign keys",
    ],
  }],

  ["foreign_key_columns", {
    description:
      "Column-level mappings for each foreign key — parent_column_id → referenced_column_id. " +
      "Join with sys.foreign_keys for constraint name and table names.",
    aliases: [
      "foreign key columns", "FK columns", "FK column mapping", "FK join column",
    ],
  }],

  ["check_constraints", {
    description:
      "CHECK constraints — definition contains the T-SQL expression. is_disabled and is_not_trusted flags.",
    aliases: ["check constraint", "constraint", "validation constraint"],
  }],

  ["key_constraints", {
    description:
      "PRIMARY KEY and UNIQUE constraints. type: PK=primary key, UQ=unique constraint. " +
      "unique_index_id links to sys.indexes.",
    aliases: ["primary key", "unique constraint", "PK constraint", "key constraint"],
  }],

  // ── Statistics ─────────────────────────────────────────────────────────────────────

  ["stats", {
    description:
      "Statistics objects on tables and indexes. " +
      "auto_created=1 = created automatically by query optimizer. " +
      "has_filter=1 = filtered statistics (partial statistics on a subset). " +
      "Join with sys.dm_db_stats_properties for update time and staleness.",
    aliases: [
      "statistics", "query statistics", "auto stats",
      "statistics object", "stats object",
    ],
  }],

  ["stats_columns", {
    description:
      "Columns covered by each statistics object — one row per column per stats object. " +
      "column_id links to sys.columns. stats_column_id is the ordinal within the stats key.",
    aliases: ["statistics columns", "stats column", "statistics key columns"],
  }],

  ["dm_db_stats_properties", {
    description:
      "Statistics freshness — last_updated timestamp, rows at last update, rows_sampled, " +
      "and modification_counter (changes since last update). " +
      "modification_counter > 0 → statistics are stale and may cause suboptimal plans.",
    aliases: [
      "statistics update", "stale statistics", "stats properties",
      "last updated statistics", "rows sampled", "statistics freshness",
    ],
    exampleQuery:
      "SELECT OBJECT_SCHEMA_NAME(s.object_id) AS schema_name, OBJECT_NAME(s.object_id) AS table_name, " +
      "s.name AS stat_name, sp.last_updated, sp.rows, sp.rows_sampled, sp.modification_counter " +
      "FROM sys.stats s CROSS APPLY sys.dm_db_stats_properties(s.object_id, s.stats_id) sp " +
      "WHERE s.object_id > 100 AND sp.modification_counter > 0 ORDER BY sp.modification_counter DESC",
  }],

  // ── Transactions and locking ───────────────────────────────────────────────────────

  ["dm_tran_locks", {
    description:
      "Current lock requests — one row per lock grant or wait. " +
      "request_status: GRANT=lock is held, WAIT=session is blocked waiting for this lock. " +
      "resource_type: DATABASE / TABLE / PAGE / KEY / ROW / METADATA. " +
      "request_mode: S=shared, X=exclusive, U=update, IS/IX/SIX=intent modes, SCH-S/SCH-M=schema locks.",
    aliases: [
      "lock", "locks", "locking", "blocked", "blocking",
      "deadlock", "current locks", "lock wait", "lock contention",
    ],
    exampleQuery:
      "SELECT resource_type, DB_NAME(resource_database_id) AS db, " +
      "request_mode, request_status, request_session_id, blocking_session_id " +
      "FROM sys.dm_tran_locks WHERE resource_database_id = DB_ID() ORDER BY request_status DESC",
  }],

  ["dm_tran_active_transactions", {
    description:
      "Active transactions — one row per open transaction. " +
      "transaction_begin_time shows when it started. Long-running open transactions hold locks and log space.",
    aliases: [
      "active transaction", "open transaction", "long running transaction",
      "transaction age", "transaction duration",
    ],
  }],

  // ── Memory ────────────────────────────────────────────────────────────────────────

  ["dm_os_memory_clerks", {
    description:
      "Memory usage by component — shows how SQL Server's total memory is divided. " +
      "type='MEMORYCLERK_SQLBUFFERPOOL' = data/index page cache (largest component). " +
      "type='CACHESTORE_SQLCP' = procedure/query plan cache. " +
      "Useful for diagnosing memory pressure: which component is consuming all the RAM.",
    aliases: [
      "memory", "memory usage", "buffer pool", "plan cache memory",
      "sql memory", "memory pressure", "memory clerk", "RAM usage",
    ],
    exampleQuery:
      "SELECT type, SUM(pages_kb)/1024 AS used_mb FROM sys.dm_os_memory_clerks " +
      "GROUP BY type ORDER BY used_mb DESC",
  }],

  ["dm_os_buffer_descriptors", {
    description:
      "Buffer pool page cache — one row per page currently in the buffer pool. " +
      "database_id, file_id, page_id identify the page. is_dirty = pending write. " +
      "Expensive to query (millions of rows). Use COUNT(*) with GROUP BY database_id only.",
    aliases: [
      "buffer pool", "cached pages", "memory pages",
      "page cache", "buffer cache", "dirty pages",
    ],
  }],

  // ── Schedulers / CPU ───────────────────────────────────────────────────────────────

  ["dm_os_schedulers", {
    description:
      "SQL Server SQLOS schedulers — one per logical CPU allocated to SQL Server. " +
      "status='VISIBLE ONLINE' = active user schedulers. " +
      "current_tasks_count = tasks on the scheduler. runnable_tasks_count > 0 = CPU pressure (tasks waiting for CPU).",
    aliases: [
      "scheduler", "cpu scheduler", "sqlos scheduler",
      "cpu pressure", "thread", "worker thread", "cpu usage",
    ],
  }],

  // ── Storage ───────────────────────────────────────────────────────────────────────

  ["dm_os_volume_stats", {
    description:
      "Disk volume information for database files — available_bytes, total_bytes per volume. " +
      "Table-valued function; pass DB_ID() and file_id (from sys.database_files). " +
      "Use to check if disk is nearly full before large data loads.",
    aliases: [
      "disk space", "disk usage", "free space", "volume space",
      "storage", "drive space", "available disk", "disk free",
    ],
  }],

  ["database_files", {
    description:
      "Database files (.mdf data files, .ldf log files, .ndf secondary data files). " +
      "type_desc: ROWS=data file, LOG=log file. " +
      "size in 8KB pages (multiply by 8192 for bytes). " +
      "max_size=-1 = unlimited autogrowth.",
    aliases: [
      "database file", "mdf", "ldf", "data file", "log file",
      "file size", "autogrowth", "database storage",
    ],
    exampleQuery:
      "SELECT name, physical_name, type_desc, size*8/1024 AS size_mb, " +
      "max_size, growth FROM sys.database_files",
  }],

  // ── High Availability / Always On ─────────────────────────────────────────────────

  ["availability_groups", {
    description:
      "Always On Availability Group definitions. " +
      "automated_backup_preference_desc: PRIMARY / SECONDARY_ONLY / SECONDARY / NONE. " +
      "failure_condition_level (1–5): threshold for automatic failover.",
    aliases: [
      "always on", "availability group", "high availability",
      "HA", "AG", "failover", "availability group definition",
    ],
  }],

  ["availability_replicas", {
    description:
      "Availability replicas within each AG — one row per replica (primary + secondaries). " +
      "endpoint_url, role_desc (PRIMARY/SECONDARY), " +
      "availability_mode_desc: SYNCHRONOUS_COMMIT / ASYNCHRONOUS_COMMIT. " +
      "Join with sys.availability_groups for the AG name.",
    aliases: [
      "replica", "replicas", "primary replica", "secondary replica",
      "availability replica", "always on replica", "synchronous", "asynchronous",
    ],
  }],

  ["dm_hadr_availability_replica_states", {
    description:
      "Live state of each availability replica. " +
      "role: 1=PRIMARY, 2=SECONDARY. " +
      "synchronization_health_desc: HEALTHY / PARTIALLY_HEALTHY / NOT_HEALTHY. " +
      "connected_state_desc: CONNECTED / DISCONNECTED. " +
      "operational_state_desc: ONLINE / OFFLINE / FAILED / FAILED_NO_QUORUM.",
    aliases: [
      "HA state", "replica state", "availability group health",
      "AG health", "always on health", "replica health", "AG status",
    ],
    exampleQuery:
      "SELECT ar.replica_server_name, ars.role_desc, ars.synchronization_health_desc, " +
      "ars.connected_state_desc, ars.operational_state_desc " +
      "FROM sys.dm_hadr_availability_replica_states ars " +
      "JOIN sys.availability_replicas ar ON ars.replica_id = ar.replica_id",
  }],

  ["dm_hadr_database_replica_states", {
    description:
      "Per-database replica state within an AG. " +
      "log_send_queue_size = KB of log not yet sent to secondary (high = primary ahead of secondary). " +
      "redo_queue_size = KB of log received but not yet applied on secondary (high = secondary lagging). " +
      "last_received_lsn versus last_redo_lsn shows synchronization lag.",
    aliases: [
      "database replica", "log send queue", "redo queue",
      "replica lag", "synchronization lag", "distributed data", "HA lag",
    ],
  }],

  // ── Server configuration ───────────────────────────────────────────────────────────

  ["configurations", {
    description:
      "Server configuration options — sp_configure view. " +
      "value_in_use = currently active value. " +
      "Key options: 'max degree of parallelism' (MAXDOP), 'max server memory (MB)', " +
      "'cost threshold for parallelism', 'optimize for ad hoc workloads', " +
      "'remote query timeout', 'backup compression default'.",
    aliases: [
      "server config", "configuration", "sp_configure", "server settings",
      "max memory", "maxdop", "parallelism", "server option",
    ],
    exampleQuery:
      "SELECT name, value_in_use, description FROM sys.configurations ORDER BY name",
  }],

  ["dm_os_sys_info", {
    description:
      "SQL Server instance-level information: cpu_count, physical_memory_kb, " +
      "sqlserver_start_time (last restart), virtual_machine_type_desc. " +
      "Single row — no parameters needed.",
    aliases: [
      "server info", "instance info", "cpu count", "physical memory",
      "server restart", "sql server version", "instance details",
    ],
    exampleQuery:
      "SELECT cpu_count, physical_memory_kb/1024 AS physical_memory_mb, " +
      "sqlserver_start_time, virtual_machine_type_desc FROM sys.dm_os_sys_info",
  }],

])
