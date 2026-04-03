/**
 * MSSQL tool — lets the agent query and interact with Microsoft SQL Server.
 *
 * Designed for DWH / data platform use cases where the agent needs to:
 *   - Explore database schema (tables, columns, types)
 *   - Run analytical queries
 *   - Inspect data quality
 *   - Help with ETL debugging
 *
 * Security:
 *   - Read-only by default (only SELECT, WITH, EXPLAIN allowed).
 *   - Write mode must be explicitly enabled via setMssqlWriteEnabled().
 *   - Connection is pooled and reused across calls.
 *   - Query timeout (30s default, configurable).
 *   - Row limit enforced (max 1000 rows returned to LLM).
 *   - No dynamic connection strings from the agent — config is set once at startup.
 */

import sql from "mssql"
import type { Tool } from "../types.js"

// ── Connection management ────────────────────────────────────────

let _pool: sql.ConnectionPool | null = null
let _config: sql.config | null = null
let _writeEnabled = false

/** Configure the MSSQL connection. Called once at server startup. */
export function setMssqlConfig(config: sql.config): void {
  _config = {
    ...config,
    options: {
      encrypt: true,
      trustServerCertificate: true,
      ...config.options,
    },
    requestTimeout: config.requestTimeout ?? 30_000,
    connectionTimeout: config.connectionTimeout ?? 15_000,
  }
}

/** Enable/disable write operations (INSERT, UPDATE, DELETE, etc.). Default: disabled. */
export function setMssqlWriteEnabled(enabled: boolean): void {
  _writeEnabled = enabled
}

/** Return a safe summary of the current config (no credentials). Null if not configured. */
export function getMssqlConfig(): { server: string; database: string; writeEnabled: boolean } | null {
  if (!_config) return null
  return { server: _config.server!, database: _config.database!, writeEnabled: _writeEnabled }
}

/** Get or create the connection pool. */
async function getPool(): Promise<sql.ConnectionPool> {
  if (!_config) throw new Error("MSSQL not configured. Call setMssqlConfig() at startup.")
  if (_pool?.connected) return _pool
  // Close stale pool if exists
  if (_pool) {
    try { await _pool.close() } catch { /* ignore */ }
  }
  _pool = new sql.ConnectionPool(_config)
  await _pool.connect()
  return _pool
}

/** Close the connection pool (called on shutdown). */
export async function closeMssqlPool(): Promise<void> {
  if (_pool) {
    try { await _pool.close() } catch { /* ignore */ }
    _pool = null
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

function validateQuery(query: string): string | null {
  if (!_writeEnabled) {
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
    "Execute a SQL query against the configured Microsoft SQL Server database. " +
    "Use this to explore schemas, query data, analyze DWH tables, check data quality, and debug ETL pipelines. " +
    "By default only SELECT/WITH queries are allowed (read-only mode). " +
    "Useful system queries: " +
    "- List tables: SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES " +
    "- List columns: SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'xxx' " +
    "- Row counts: SELECT COUNT(*) FROM schema.table " +
    "- Table sizes: sp_spaceused 'schema.table' " +
    "Returns results as plain text table format.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The SQL query to execute. Must be a valid T-SQL statement.",
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

    // Validate before executing
    const error = validateQuery(query)
    if (error) return error

    try {
      const pool = await getPool()

      // Optional database switch
      const db = args.database ? String(args.database).trim() : null
      if (db) {
        // Validate database name (alphanumeric, underscores, hyphens only)
        if (!/^[\w-]+$/.test(db)) {
          return "Error: invalid database name."
        }
      }

      const request = pool.request()

      // If a specific database is requested, prefix with USE
      const fullQuery = db ? `USE [${db}];\n${query}` : query

      const result = await request.query(fullQuery)
      return formatResults(result.recordsets as sql.IRecordSet<unknown>[], result.rowsAffected)
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
    "Quickly explore the MSSQL database schema. Returns tables, views, and their columns. " +
    "Use this before writing queries to understand the data model. " +
    "Much faster than manual INFORMATION_SCHEMA queries for getting an overview.",
  parameters: {
    type: "object",
    properties: {
      schema: {
        type: "string",
        description: "Filter by schema name (e.g., 'dbo', 'staging', 'dwh'). Leave empty for all schemas.",
      },
      table: {
        type: "string",
        description: "Get detailed column info for a specific table. Include schema prefix (e.g., 'dwh.FactSales').",
      },
    },
    required: [],
  },

  async execute(args) {
    try {
      const pool = await getPool()
      const request = pool.request()

      if (args.table) {
        const tableName = String(args.table)
        // Parameterize the table lookup
        const parts = tableName.split(".")
        const schema = parts.length > 1 ? parts[0] : "dbo"
        const table = parts.length > 1 ? parts[1] : parts[0]

        request.input("schema", sql.NVarChar, schema)
        request.input("table", sql.NVarChar, table)

        const result = await request.query(`
          SELECT
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
          WHERE c.TABLE_SCHEMA = @schema AND c.TABLE_NAME = @table
          ORDER BY c.ORDINAL_POSITION
        `)

        if (!result.recordset.length) return `No columns found for ${tableName}`
        return `Columns for ${schema}.${table}:\n` +
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `SQL Error: ${msg}`
    }
  },
}
