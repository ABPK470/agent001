/**
 * MSSQL tool — lets the agent query and interact with Microsoft SQL Server.
 *
 * Supports multiple named database connections configured at startup.
 * The agent can target a specific connection via the optional `connection`
 * parameter on query_mssql and explore_mssql_schema.
 *
 * Designed for DWH / data platform use cases where the agent needs to:
 *   - Explore database schema (tables, columns, types)
 *   - Run analytical queries
 *   - Inspect data quality
 *   - Help with ETL debugging
 *
 * Security:
 *   - Read-only by default (only SELECT, WITH, EXPLAIN allowed).
 *   - Write mode must be explicitly enabled per connection.
 *   - Connections are pooled and reused across calls.
 *   - Query timeout (30s default, configurable).
 *   - Row limit enforced (max 1000 rows returned to LLM).
 *   - No dynamic connection strings from the agent — config is set once at startup.
 */

import sql from "mssql"
import type { Tool } from "../types.js"

// ── Named connection registry ────────────────────────────────────

interface DatabaseEntry {
  config: sql.config
  pool: sql.ConnectionPool | null
  writeEnabled: boolean
  knowledge: string | null
}

const _databases = new Map<string, DatabaseEntry>()

/** Per-tool-call kill signal — when aborted, cancels any in-flight query. */
let _killSignal: AbortSignal | null = null

/** Set by the orchestrator when a per-tool kill is registered/cleared. */
export function setMssqlKillSignal(signal: AbortSignal | null): void {
  _killSignal = signal
}

/**
 * Configure a single MSSQL connection.
 * @param config  mssql connection config
 * @param name    Connection name used in the `connection` tool parameter.
 *                Defaults to "default" for backwards compatibility.
 */
export function setMssqlConfig(config: sql.config, name = "default", knowledge: string | null = null): void {
  _databases.set(name, {
    config: {
      ...config,
      options: {
        encrypt: true,
        trustServerCertificate: true,
        ...config.options,
      },
      requestTimeout: config.requestTimeout ?? 30_000,
      connectionTimeout: config.connectionTimeout ?? 15_000,
    },
    pool: null,
    writeEnabled: false,
    knowledge,
  })
}

/**
 * Configure multiple named MSSQL connections at once (replaces all existing).
 * Each entry must include a `name` field. The first entry is also the "default".
 */
export function setMssqlConfigs(
  configs: Array<{ name: string; writeEnabled?: boolean; knowledge?: string | null } & sql.config>,
): void {
  _databases.clear()
  for (const { name, writeEnabled = false, knowledge = null, ...rest } of configs) {
    _databases.set(name, {
      config: {
        ...rest,
        options: {
          encrypt: true,
          trustServerCertificate: true,
          ...(rest as sql.config).options,
        },
        requestTimeout: (rest as sql.config).requestTimeout ?? 30_000,
        connectionTimeout: (rest as sql.config).connectionTimeout ?? 15_000,
      },
      pool: null,
      writeEnabled,
      knowledge,
    })
  }
}

/** Enable/disable write operations for a named connection (default: "default"). */
export function setMssqlWriteEnabled(enabled: boolean, name = "default"): void {
  const entry = _databases.get(name)
  if (entry) entry.writeEnabled = enabled
}

/** Return a safe summary of all configured connections (no credentials). */
export function getMssqlConfig(): Array<{ name: string; server: string; database: string; writeEnabled: boolean; knowledge: string | null }> {
  return Array.from(_databases.entries()).map(([name, entry]) => ({
    name,
    server: entry.config.server!,
    database: entry.config.database!,
    writeEnabled: entry.writeEnabled,
    knowledge: entry.knowledge,
  }))
}

/** Get or create the connection pool for a named connection. */
export async function getPool(name = "default"): Promise<{ pool: sql.ConnectionPool; entry: DatabaseEntry }> {
  const entry = _databases.get(name)
  if (!entry) {
    const available = Array.from(_databases.keys()).join(", ") || "none"
    throw new Error(
      `MSSQL connection "${name}" not configured. Available: ${available}. ` +
      `Call setMssqlConfig() or setMssqlConfigs() at startup.`,
    )
  }
  if (entry.pool?.connected) return { pool: entry.pool, entry }
  if (entry.pool) {
    try { await entry.pool.close() } catch { /* ignore */ }
  }
  entry.pool = new sql.ConnectionPool(entry.config)
  await entry.pool.connect()
  return { pool: entry.pool, entry }
}

/** Close all connection pools (called on shutdown). */
export async function closeMssqlPool(): Promise<void> {
  for (const entry of _databases.values()) {
    if (entry.pool) {
      try { await entry.pool.close() } catch { /* ignore */ }
      entry.pool = null
    }
  }
}

// ── Query validation ─────────────────────────────────────────────

const READ_ONLY_PATTERN = /^\s*(SELECT|WITH|EXPLAIN|SET\s+SHOWPLAN|SP_HELP|SP_COLUMNS|SP_TABLES)\b/i

const DANGEROUS_PATTERNS = [
  /;\s*(DROP|ALTER|TRUNCATE|EXEC|EXECUTE|XP_|SP_EXECUTESQL|OPENROWSET|OPENQUERY|OPENDATASOURCE)\b/i,
  /INTO\s+\w+\s*\(/i,                                    // SELECT INTO
  /BULK\s+INSERT/i,
  /DBCC\b/i,
  /SHUTDOWN\b/i,
  /RECONFIGURE\b/i,
]

function validateQuery(query: string, writeEnabled: boolean): string | null {
  if (!writeEnabled) {
    if (!READ_ONLY_PATTERN.test(query)) {
      return "Write operations are disabled. Only SELECT/WITH queries are allowed. " +
             "Contact your administrator to enable write mode."
    }
  }

  // Always block dangerous operations regardless of write mode
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(query)) {
      return "Query blocked: contains potentially dangerous operation (DROP, ALTER, EXEC, xp_, BULK INSERT, DBCC, SHUTDOWN, etc.)."
    }
  }

  return null // valid
}

// ── Row formatting ───────────────────────────────────────────────

const MAX_ROWS = 1000
const MAX_RESULT_LENGTH = 50_000

function formatResults(recordsets: sql.IRecordSet<unknown>[], rowsAffected: number[]): string {
  if (recordsets.length === 0) {
    return `Query executed. Rows affected: ${rowsAffected.join(", ")}`
  }

  const parts: string[] = []

  for (let i = 0; i < recordsets.length; i++) {
    const rs = recordsets[i]
    if (!rs || rs.length === 0) {
      parts.push(i > 0 ? `\n--- Result set ${i + 1}: (empty) ---` : "(empty result set)")
      continue
    }

    const columns = Object.keys(rs[0] as Record<string, unknown>)
    const rows = rs.slice(0, MAX_ROWS)
    const truncated = rs.length > MAX_ROWS

    if (recordsets.length > 1) {
      parts.push(`\n--- Result set ${i + 1} (${rs.length} rows) ---`)
    } else {
      parts.push(`(${rs.length} row${rs.length !== 1 ? "s" : ""})`)
    }

    // Column headers
    parts.push(columns.join(" | "))
    parts.push(columns.map((c) => "-".repeat(Math.min(c.length, 20))).join("-+-"))

    // Data rows
    for (const row of rows) {
      const r = row as Record<string, unknown>
      const vals = columns.map((c) => {
        const v = r[c]
        if (v === null || v === undefined) return "NULL"
        if (v instanceof Date) return v.toISOString()
        if (typeof v === "object") return JSON.stringify(v)
        return String(v)
      })
      parts.push(vals.join(" | "))
    }

    if (truncated) {
      parts.push(`... (${rs.length - MAX_ROWS} more rows truncated, showing first ${MAX_ROWS})`)
    }
  }

  let result = parts.join("\n")
  if (result.length > MAX_RESULT_LENGTH) {
    result = result.slice(0, MAX_RESULT_LENGTH) + "\n... (output truncated)"
  }
  return result
}

// ── The tool ─────────────────────────────────────────────────────

export const mssqlTool: Tool = {
  name: "query_mssql",
  description:
    "Execute a T-SQL query against Microsoft SQL Server. Read-only by default (SELECT/WITH only). " +
    "CRITICAL: NEVER guess column names. Before writing ANY query, call explore_mssql_schema first " +
    "to get the exact column names and types for each table you plan to query. " +
    "Always use schema-qualified table names (e.g. agent.PipelineRun, not just PipelineRun). " +
    "When data spans multiple tables/views, explore EACH table first, then JOIN them. " +
    "For large tables (>1M rows), always include WHERE clauses with date filters and use TOP. " +
    "Returns results as plain text table format.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The SQL query to execute. Must be a valid T-SQL statement.",
      },
      connection: {
        type: "string",
        description: "Named database connection to use (configured at startup). Omit to use the default connection.",
      },
      database: {
        type: "string",
        description: "Optional: switch to a different database before running the query. Equivalent to USE [database].",
      },
    },
    required: ["query"],
  },

  async execute(args) {
    const query = String(args.query).trim()
    if (!query) return "Error: query cannot be empty."

    const connectionName = args.connection ? String(args.connection).trim() : "default"

    let pool: sql.ConnectionPool
    let entry: DatabaseEntry
    try {
      const result = await getPool(connectionName)
      pool = result.pool
      entry = result.entry
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }

    // Validate before executing
    const error = validateQuery(query, entry.writeEnabled)
    if (error) return error

    try {
      // Optional database switch
      const db = args.database ? String(args.database).trim() : null
      if (db) {
        // Validate database name (alphanumeric, underscores, hyphens only)
        if (!/^[\w-]+$/.test(db)) {
          return "Error: invalid database name."
        }
      }

      const request = pool.request()

      // If a kill signal fires while the query is running, cancel it immediately
      const onKill = (): void => { request.cancel() }
      if (_killSignal) {
        if (_killSignal.aborted) return "Error: Tool execution cancelled"
        _killSignal.addEventListener("abort", onKill, { once: true })
      }

      // If a specific database is requested, prefix with USE
      const fullQuery = db ? `USE [${db}];\n${query}` : query

      try {
        const result = await request.query(fullQuery)
        return formatResults(result.recordsets as sql.IRecordSet<unknown>[], result.rowsAffected)
      } finally {
        _killSignal?.removeEventListener("abort", onKill)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `SQL Error: ${msg}`
    }
  },
}

// ── Schema explorer (convenience tool) ───────────────────────────

export const mssqlSchemaTool: Tool = {
  name: "explore_mssql_schema",
  description:
    "Explore the MSSQL database schema — list tables/views in a schema, or get exact column names and types for a table. " +
    "ALWAYS call this BEFORE writing any query_mssql query. This is mandatory, not optional. " +
    "Step 1: Call with schema='agent' to list tables in that schema. " +
    "Step 2: Call with table='agent.PipelineRun' to get exact columns. " +
    "Step 3: Only THEN write your query_mssql using the discovered column names. " +
    "Never assume column names — they are often different from what you'd expect.",
  parameters: {
    type: "object",
    properties: {
      schema: {
        type: "string",
        description: "Filter by schema name (e.g., 'agent', 'core', 'publish', 'dim', 'fact'). Lists all tables/views in that schema.",
      },
      table: {
        type: "string",
        description: "Get detailed column info for a specific table. Use schema prefix for accuracy (e.g., 'agent.PipelineRun', 'core.Dataset', 'fact.AfricaFlex'). Without prefix, searches all schemas.",
      },
      search: {
        type: "string",
        description: "Search for tables/views by name pattern across all schemas. Uses SQL LIKE with wildcards added automatically. E.g., search='Revenue' finds all tables/views containing 'Revenue' in any schema. search='Pipeline' finds agent.PipelineRun, core.Pipeline, etc.",
      },
      connection: {
        type: "string",
        description: "Named database connection to use (configured at startup). Omit to use the default connection.",
      },
    },
    required: [],
  },

  async execute(args) {
    const connectionName = args.connection ? String(args.connection).trim() : "default"

    let pool: sql.ConnectionPool
    try {
      const result = await getPool(connectionName)
      pool = result.pool
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }

    try {
      const request = pool.request()

      // If a kill signal fires while the query is running, cancel it immediately
      const onKill = (): void => { request.cancel() }
      if (_killSignal) {
        if (_killSignal.aborted) return "Error: Tool execution cancelled"
        _killSignal.addEventListener("abort", onKill, { once: true })
      }

      try {
      if (args.table) {
        const tableName = String(args.table)
        // Parameterize the table lookup
        const parts = tableName.split(".")
        const schema = parts.length > 1 ? parts[0] : null
        const table = parts.length > 1 ? parts[1] : parts[0]

        request.input("table", sql.NVarChar, table)
        if (schema) {
          request.input("schema", sql.NVarChar, schema)
        }

        const result = await request.query(`
          SELECT
            c.TABLE_SCHEMA,
            c.COLUMN_NAME,
            c.DATA_TYPE,
            c.CHARACTER_MAXIMUM_LENGTH,
            c.IS_NULLABLE,
            c.COLUMN_DEFAULT,
            CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 'YES' ELSE 'NO' END AS IS_PRIMARY_KEY,
            CASE WHEN fk.COLUMN_NAME IS NOT NULL THEN fk.REFERENCED_TABLE ELSE NULL END AS FK_REFERENCES
          FROM INFORMATION_SCHEMA.COLUMNS c
          LEFT JOIN (
            SELECT ku.COLUMN_NAME, ku.TABLE_SCHEMA, ku.TABLE_NAME
            FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
            JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
              ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
            WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
          ) pk ON pk.TABLE_SCHEMA = c.TABLE_SCHEMA AND pk.TABLE_NAME = c.TABLE_NAME AND pk.COLUMN_NAME = c.COLUMN_NAME
          LEFT JOIN (
            SELECT
              cu.COLUMN_NAME, cu.TABLE_SCHEMA, cu.TABLE_NAME,
              ku2.TABLE_SCHEMA + '.' + ku2.TABLE_NAME AS REFERENCED_TABLE
            FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
            JOIN INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE cu ON rc.CONSTRAINT_NAME = cu.CONSTRAINT_NAME
            JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku2 ON rc.UNIQUE_CONSTRAINT_NAME = ku2.CONSTRAINT_NAME
          ) fk ON fk.TABLE_SCHEMA = c.TABLE_SCHEMA AND fk.TABLE_NAME = c.TABLE_NAME AND fk.COLUMN_NAME = c.COLUMN_NAME
          WHERE ${schema ? "c.TABLE_SCHEMA = @schema AND" : ""} c.TABLE_NAME = @table
          ORDER BY c.TABLE_SCHEMA, c.ORDINAL_POSITION
        `)

        if (!result.recordset.length) return `No columns found for ${tableName}. Try with schema prefix (e.g. 'agent.${table}', 'core.${table}').`
        const label = schema ? `${schema}.${table}` : result.recordset[0].TABLE_SCHEMA + "." + table
        return `Columns for ${label}:\n` +
          formatResults(result.recordsets as sql.IRecordSet<unknown>[], result.rowsAffected)
      }

      // Search for tables/views by name pattern
      if (args.search) {
        const pattern = `%${String(args.search)}%`
        request.input("pattern", sql.NVarChar, pattern)

        const result = await request.query(`
          SELECT
            t.TABLE_SCHEMA,
            t.TABLE_NAME,
            t.TABLE_TYPE,
            (SELECT SUM(p.rows) FROM sys.partitions p
             JOIN sys.tables st ON p.object_id = st.object_id
             JOIN sys.schemas s ON st.schema_id = s.schema_id
             WHERE s.name = t.TABLE_SCHEMA AND st.name = t.TABLE_NAME AND p.index_id IN (0,1)
            ) AS ROW_COUNT
          FROM INFORMATION_SCHEMA.TABLES t
          WHERE t.TABLE_NAME LIKE @pattern
          ORDER BY t.TABLE_SCHEMA, t.TABLE_TYPE, t.TABLE_NAME
        `)

        if (!result.recordset.length) return `No tables/views found matching '${String(args.search)}'. Try a different keyword.`
        return `Tables/views matching '${String(args.search)}':\n` +
          formatResults(result.recordsets as sql.IRecordSet<unknown>[], result.rowsAffected)
      }

      // List all tables/views
      const schemaFilter = args.schema ? String(args.schema) : null
      if (schemaFilter) {
        request.input("schema", sql.NVarChar, schemaFilter)
      }

      const result = await request.query(`
        SELECT
          t.TABLE_SCHEMA,
          t.TABLE_NAME,
          t.TABLE_TYPE,
          (SELECT SUM(p.rows) FROM sys.partitions p
           JOIN sys.tables st ON p.object_id = st.object_id
           JOIN sys.schemas s ON st.schema_id = s.schema_id
           WHERE s.name = t.TABLE_SCHEMA AND st.name = t.TABLE_NAME AND p.index_id IN (0,1)
          ) AS ROW_COUNT
        FROM INFORMATION_SCHEMA.TABLES t
        ${schemaFilter ? "WHERE t.TABLE_SCHEMA = @schema" : ""}
        ORDER BY t.TABLE_SCHEMA, t.TABLE_TYPE, t.TABLE_NAME
      `)

      if (!result.recordset.length) return "No tables found."
      return formatResults(result.recordsets as sql.IRecordSet<unknown>[], result.rowsAffected)
      } finally {
        _killSignal?.removeEventListener("abort", onKill)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `SQL Error: ${msg}`
    }
  },
}
